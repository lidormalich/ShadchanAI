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
  if (!effectiveText) {
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

  if (regex.isTemplateForm) {
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
  if (match.strength === 'exact' || (match.strength === 'strong' && regex.confidence >= 0.5)) {
    const updated = await linkToExisting(match.candidate!, message);
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

  if (!regexSufficient) {
    try {
      const ai = await extractProfileWithAI(effectiveText, { messageId: String(message._id) });
      if (!ai.profile.isProfile) {
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
      if (!regex.isLikelyProfile) {
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
    return finalize(message, {
      status: MessageExtractionStatus.NEEDS_REVIEW,
      method,
      confidence: combinedConfidence,
      matchedFields: Object.keys(profile),
    });
  }

  const created = await createFromProfile(profile, message);
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
  message.extraction = {
    status: outcome.status,
    method: outcome.method,
    attemptedAt: message.extraction?.attemptedAt ?? new Date(),
    completedAt: new Date(),
    candidateId: outcome.candidateId ? new Types.ObjectId(outcome.candidateId) : undefined,
    confidence: outcome.confidence,
    failureReason: outcome.failureReason,
    matchedFields: outcome.matchedFields,
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
