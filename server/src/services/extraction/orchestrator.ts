// ═══════════════════════════════════════════════════════════
// ShadchanAI — Extraction Orchestrator
//
// Runs the full profile-extraction pipeline on a single inbound
// message from a profiles_source channel:
//
//   1. Regex pre-parse
//   2. Candidate lookup (phone > name+age > name)
//   3. If existing candidate → update lastSourceUpdateAt, link message, DONE.
//   4. If new AND regex is confident → upsert candidate (status=active).
//   5. Otherwise → AI extraction (Groq → OpenAI fallback).
//   6. Re-run candidate lookup with AI result.
//   7. If still new:
//        - combined confidence ≥ 0.7 → create candidate (status=active).
//        - combined confidence <  0.7 → status=needs_review — human gate.
//
// Every outcome writes message.extraction.status + the orchestrator
// returns a typed summary the caller can log / surface in UI.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import {
  ExtractionMethod,
  ExternalCandidateStatus,
  ExternalSourceType,
  MessageExtractionStatus,
} from '@shadchanai/shared';
import {
  ExternalCandidate,
  Message,
  type IExternalCandidate,
  type IMessage,
} from '../../models/index.js';
import { extractProfileFromText, type ExtractedProfile } from './regex.extractor.js';
import { findExistingCandidate, type MatchResult } from './candidate.matcher.js';
import { extractProfileWithAI, type AIExtractedProfile } from './ai.extractor.js';
import { publishRealtimeEvent } from '../realtime/realtime.service.js';
import { normalizePhone } from '../../utils/phone.js';
import { createLogger } from '../../utils/logger.js';

// End-to-end flow logger. Every message's journey through the engine emits
// one line per stage under the 'extraction.flow' scope, keyed by messageId,
// so a single grep reveals exactly where a message stopped (and why).
const flow = createLogger('extraction.flow');
const preview = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 60);

// Threshold tuning. Moved here rather than into env so the decisions
// live next to the logic that makes them. Revisit after ~100 messages
// of real traffic.
const REGEX_CONFIDENCE_SKIP_AI = 0.8; // regex this good → trust, don't call AI
const AI_CONFIDENCE_AUTO_CREATE = 0.7; // AI confidence below this → needs_review

export interface ExtractionOutcome {
  status: MessageExtractionStatus;
  method: ExtractionMethod;
  candidateId?: string;
  confidence: number;
  matchedFields: string[];
  failureReason?: string;
  matchResult?: MatchResult['strength'];
}

/**
 * Process a single message through the full extraction pipeline.
 * Idempotent: safe to call twice on the same messageId — duplicate
 * creation is prevented by re-matching before upsert.
 */
export async function processMessageExtraction(messageId: string): Promise<ExtractionOutcome> {
  if (!Types.ObjectId.isValid(messageId)) {
    return fail('invalid_message_id');
  }

  const message = await Message.findById(messageId).exec();
  if (!message) return fail('message_not_found');

  // Phase 7: fall back to media caption when body is empty. An
  // image-with-caption profile ("שדכנים — שרה בת 24…" with photo)
  // was previously silently ignored; now we extract from the caption.
  const effectiveText = (message.body?.trim() || message.mediaCaption?.trim() || '');
  flow.info(
    { messageId, contentType: message.contentType, textLen: effectiveText.length, preview: preview(effectiveText) },
    'flow_start',
  );
  if (!effectiveText) {
    flow.info({ messageId, contentType: message.contentType }, 'flow_stop: no_text (media without caption)');
    return finalize(message, {
      status: MessageExtractionStatus.SKIPPED_NOT_PROFILE,
      method: ExtractionMethod.REGEX,
      confidence: 0,
      matchedFields: [],
      failureReason: 'no_text',
    });
  }

  // ── 1. Regex pre-parse ─────────────────────────────────
  const regex = extractProfileFromText(effectiveText);
  flow.info(
    {
      messageId,
      regexConfidence: regex.confidence,
      isTemplateForm: regex.isTemplateForm,
      isLikelyProfile: regex.isLikelyProfile,
      hasName: !!regex.profile.firstName,
      hasPhone: !!regex.profile.contactPhones?.length,
      fields: regex.matchedFields,
    },
    'regex_parsed',
  );

  if (regex.isTemplateForm) {
    flow.info({ messageId }, 'flow_stop: skipped_template (looks like a blank template/form)');
    return finalize(message, {
      status: MessageExtractionStatus.SKIPPED_TEMPLATE,
      method: ExtractionMethod.REGEX,
      confidence: 0,
      matchedFields: regex.matchedFields,
    });
  }

  // ── 2. Early lookup on regex result ───────────────────
  let profile: ExtractedProfile = regex.profile;
  let combinedConfidence = regex.confidence;
  let method: ExtractionMethod = ExtractionMethod.REGEX;

  let match = await findExistingCandidate(profile);
  flow.info({ messageId, matchStrength: match.strength }, 'regex_match_lookup');
  if (match.strength === 'exact' || (match.strength === 'strong' && regex.confidence >= 0.5)) {
    const updated = await linkToExisting(match.candidate!, message);
    flow.info({ messageId, candidateId: String(updated._id) }, 'flow_stop: matched_existing (linked, no new profile)');
    return finalize(message, {
      status: MessageExtractionStatus.MATCHED_EXISTING,
      method,
      candidateId: String(updated._id),
      confidence: combinedConfidence,
      matchedFields: regex.matchedFields,
      matchResult: match.strength,
    });
  }

  // ── 3. Decide whether to call AI ──────────────────────
  // Skip AI only when regex is strong AND we produced a name — because
  // without a name there's nothing to deduplicate against in tier 2/3.
  const regexSufficient =
    regex.confidence >= REGEX_CONFIDENCE_SKIP_AI &&
    regex.isLikelyProfile &&
    !!profile.firstName;

  if (regexSufficient) {
    flow.info({ messageId }, 'ai_skipped (regex confident + has name)');
  } else {
    flow.info({ messageId }, 'ai_calling');
    try {
      const ai = await extractProfileWithAI(effectiveText, { messageId: String(message._id) });
      flow.info({ messageId, isProfile: ai.profile.isProfile, aiConfidence: ai.profile.confidence }, 'ai_result');
      if (!ai.profile.isProfile) {
        flow.info({ messageId }, 'flow_stop: skipped_not_profile (AI says not a profile)');
        return finalize(message, {
          status: MessageExtractionStatus.SKIPPED_NOT_PROFILE,
          method: ExtractionMethod.AI,
          confidence: ai.profile.confidence,
          matchedFields: regex.matchedFields,
        });
      }
      profile = mergeProfiles(regex.profile, ai.profile);
      combinedConfidence = Math.max(regex.confidence, ai.profile.confidence);
      method = ExtractionMethod.AI;

      // Re-match with the enriched profile (AI may have recovered a
      // name/phone the regex missed).
      match = await findExistingCandidate(profile);
      if (match.strength === 'exact' || match.strength === 'strong') {
        const updated = await linkToExisting(match.candidate!, message);
        flow.info({ messageId, candidateId: String(updated._id) }, 'flow_stop: matched_existing (after AI)');
        return finalize(message, {
          status: MessageExtractionStatus.MATCHED_EXISTING,
          method,
          candidateId: String(updated._id),
          confidence: combinedConfidence,
          matchedFields: Object.keys(profile),
          matchResult: match.strength,
        });
      }
    } catch (err) {
      // AI failed — if regex gave us SOMETHING usable, proceed with it,
      // marked as needs_review. If not, bubble the failure for the
      // reconciler to retry.
      flow.warn(
        { messageId, error: (err as Error).message, fallback: regex.isLikelyProfile ? 'regex' : 'none' },
        'ai_failed',
      );
      if (!regex.isLikelyProfile) {
        flow.warn({ messageId }, 'flow_stop: failed (AI unavailable + regex not a likely profile) — will retry via reconciler');
        return finalize(message, {
          status: MessageExtractionStatus.FAILED,
          method: ExtractionMethod.AI,
          confidence: 0,
          matchedFields: regex.matchedFields,
          failureReason: (err as Error).message,
        });
      }
      method = ExtractionMethod.REGEX;
    }
  }

  // ── 4. Nothing matched → create or queue for review ───
  if (!profile.firstName && !profile.contactPhones?.length) {
    // No key identifier → can't safely create. Mark for human review.
    flow.info({ messageId, confidence: combinedConfidence }, 'flow_stop: needs_review (no name or phone extracted → profile request)');
    return finalize(message, {
      status: MessageExtractionStatus.NEEDS_REVIEW,
      method,
      confidence: combinedConfidence,
      matchedFields: Object.keys(profile),
      failureReason: 'no name or phone extracted',
    });
  }

  const autoCreate = combinedConfidence >= AI_CONFIDENCE_AUTO_CREATE;
  if (!autoCreate) {
    flow.info(
      { messageId, confidence: combinedConfidence, threshold: AI_CONFIDENCE_AUTO_CREATE },
      'flow_stop: needs_review (confidence below auto-create threshold → profile request)',
    );
    return finalize(message, {
      status: MessageExtractionStatus.NEEDS_REVIEW,
      method,
      confidence: combinedConfidence,
      matchedFields: Object.keys(profile),
    });
  }

  const created = await createFromProfile(profile, message);
  flow.info({ messageId, candidateId: String(created._id), confidence: combinedConfidence }, 'flow_stop: created_new (profile created)');
  return finalize(message, {
    status: MessageExtractionStatus.CREATED_NEW,
    method,
    candidateId: String(created._id),
    confidence: combinedConfidence,
    matchedFields: Object.keys(profile),
  });
}

// ── Helpers ──────────────────────────────────────────────

function mergeProfiles(regexP: ExtractedProfile, ai: AIExtractedProfile): ExtractedProfile {
  // Prefer regex fields first (deterministic); fall back to AI for
  // anything regex didn't capture. Both-present → keep regex.
  const out: ExtractedProfile = { ...regexP };
  if (!out.firstName && ai.firstName) out.firstName = ai.firstName;
  if (!out.lastName && ai.lastName) out.lastName = ai.lastName;
  if (!out.gender && ai.gender) out.gender = ai.gender;
  if (!out.age && ai.age) out.age = ai.age;
  if (!out.height && ai.height) out.height = ai.height;
  if (!out.city && ai.city) out.city = ai.city;
  if (!out.edah && ai.edah) out.edah = ai.edah;
  if (!out.sectorGroup && ai.sectorGroup) out.sectorGroup = ai.sectorGroup;
  if (!out.religiousLevelText && ai.religiousLevelText) out.religiousLevelText = ai.religiousLevelText;
  if (!out.personalStatus && ai.personalStatus) out.personalStatus = ai.personalStatus;
  if (!out.occupation && ai.occupation) out.occupation = ai.occupation;
  if (!out.about && ai.about) out.about = ai.about;
  if (!out.whatSeeking && ai.whatSeeking) out.whatSeeking = ai.whatSeeking;
  if (!out.seekingAgeMin && ai.seekingAgeMin) out.seekingAgeMin = ai.seekingAgeMin;
  if (!out.seekingAgeMax && ai.seekingAgeMax) out.seekingAgeMax = ai.seekingAgeMax;
  if ((!out.contactPhones || out.contactPhones.length === 0) && ai.contactPhones?.length) {
    out.contactPhones = ai.contactPhones;
  }
  return out;
}

async function linkToExisting(candidate: IExternalCandidate, message: IMessage): Promise<IExternalCandidate> {
  // Append this message to the source list (deduped) and refresh activity
  // timestamps. Status/field updates are NOT made here — re-imports should
  // not overwrite curated data without human review.
  candidate.sourceMessageIds = dedupeObjectIds([
    ...(candidate.sourceMessageIds ?? []),
    message._id as Types.ObjectId,
  ]);
  candidate.lastSourceUpdateAt = message.createdAt;
  if (!candidate.sourceChannelId) candidate.sourceChannelId = message.channelId;
  await candidate.save();
  return candidate;
}

async function createFromProfile(profile: ExtractedProfile, message: IMessage): Promise<IExternalCandidate> {
  const primaryPhone = profile.contactPhones?.[0];
  const normalizedPhone = normalizePhone(primaryPhone);
  return ExternalCandidate.create({
    sourceType: ExternalSourceType.WHATSAPP_GROUP,
    sourceChannelId: message.channelId,
    sourceImportedAt: message.createdAt,
    lastSourceUpdateAt: message.createdAt,
    contactPhone: primaryPhone,
    contactPhoneNormalized: normalizedPhone ?? undefined,
    sourceMessageIds: [message._id],
    firstName: profile.firstName,
    lastName: profile.lastName,
    gender: profile.gender,
    age: profile.age,
    city: profile.city,
    sectorGroup: profile.sectorGroup,
    personalStatus: profile.personalStatus,
    height: profile.height,
    about: profile.about,
    whatSeeking: profile.whatSeeking,
    agePreferences: (profile.seekingAgeMin || profile.seekingAgeMax)
      ? { min: profile.seekingAgeMin, max: profile.seekingAgeMax }
      : undefined,
    status: ExternalCandidateStatus.ACTIVE,
  });
}

function dedupeObjectIds(ids: Types.ObjectId[]): Types.ObjectId[] {
  const seen = new Set<string>();
  const out: Types.ObjectId[] = [];
  for (const id of ids) {
    const k = String(id);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(id);
    }
  }
  return out;
}

async function finalize(
  message: IMessage,
  outcome: Omit<ExtractionOutcome, 'matchResult'> & { matchResult?: MatchResult['strength'] },
): Promise<ExtractionOutcome> {
  // Track failed attempts so the reconciler can stop auto-retrying a
  // message that keeps failing (e.g. AI provider persistently down for
  // one malformed body). A non-failure outcome preserves the count but
  // does not increment it.
  const priorRetries = message.extraction?.retryCount ?? 0;
  const retryCount =
    outcome.status === MessageExtractionStatus.FAILED ? priorRetries + 1 : priorRetries;

  message.extraction = {
    status: outcome.status,
    method: outcome.method,
    attemptedAt: message.extraction?.attemptedAt ?? new Date(),
    completedAt: new Date(),
    candidateId: outcome.candidateId ? new Types.ObjectId(outcome.candidateId) : undefined,
    confidence: outcome.confidence,
    failureReason: outcome.failureReason,
    matchedFields: outcome.matchedFields,
    retryCount,
  };
  await message.save();

  // Surface review-queue arrivals to connected operators live.
  if (outcome.status === MessageExtractionStatus.NEEDS_REVIEW) {
    publishRealtimeEvent('extraction.needs_review', {
      messageId: String(message._id),
      conversationId: String(message.conversationId),
      channelId: message.channelId,
      confidence: outcome.confidence,
    });
  }

  return outcome;
}

function fail(reason: string): ExtractionOutcome {
  return {
    status: MessageExtractionStatus.FAILED,
    method: ExtractionMethod.REGEX,
    confidence: 0,
    matchedFields: [],
    failureReason: reason,
  };
}
