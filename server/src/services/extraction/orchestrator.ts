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
  AvailabilityStatus,
  ExtractionMethod,
  ExternalCandidateStatus,
  ExternalSourceType,
  MessageExtractionStatus,
} from '@shadchanai/shared';
import {
  ExternalCandidate,
  Message,
  ChatMapping,
  type IExternalCandidate,
  type IMessage,
} from '../../models/index.js';
import { extractProfileFromText, type ExtractedProfile } from './regex.extractor.js';
import { findExistingCandidate, type MatchResult } from './candidate.matcher.js';
import { buildIdentityKey } from '../../utils/identity.js';
import { extractProfileWithAI, type AIExtractedProfile } from './ai.extractor.js';
import { extractProfileFromImage, visionExtractionAvailable } from './vision.extractor.js';
import { downloadInboundMedia } from '../whatsapp/media.service.js';
import { attachSourcePhotoToExternalCandidate } from '../storage/photo-maintenance.service.js';
import { scheduleNewExternalCandidateAlert } from '../notifications/new-match-alert.service.js';
import { publishRealtimeEvent } from '../realtime/realtime.service.js';
import { getSettingCached } from '../../modules/settings/settings.service.js';
import { isDuplicateKeyError } from '../../utils/errors.js';
import { normalizePhone } from '../../utils/phone.js';
import { createLogger } from '../../utils/logger.js';

// End-to-end flow logger. Every message's journey through the engine emits
// one line per stage under the 'extraction.flow' scope, keyed by messageId,
// so a single grep reveals exactly where a message stopped (and why).
const flow = createLogger('extraction.flow');
const preview = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 60);

// Threshold defaults. Operator-tunable at runtime via Settings
// ('extraction.regex_skip_ai_confidence' / 'extraction.auto_create_confidence');
// these constants are only the fallbacks when settings reads fail.
const REGEX_CONFIDENCE_SKIP_AI_DEFAULT = 0.8; // regex this good → trust, don't call AI
const AI_CONFIDENCE_AUTO_CREATE_DEFAULT = 0.7; // AI confidence below this → needs_review
// Stricter bar for the label-less "structured AI agreement" corroboration path:
// higher than auto_create because here the AI's read is the ONLY signal (no
// regex structure), so we demand more confidence before trusting it to create.
const AI_CORROBORATION_CONFIDENCE_DEFAULT = 0.85;

async function resolveThresholds(): Promise<{ regexSkipAi: number; autoCreate: number; aiCorroborate: number }> {
  try {
    const [regexSkipAi, autoCreate, aiCorroborate] = await Promise.all([
      getSettingCached('extraction.regex_skip_ai_confidence'),
      getSettingCached('extraction.auto_create_confidence'),
      getSettingCached('extraction.ai_corroboration_confidence'),
    ]);
    return {
      regexSkipAi: regexSkipAi as number,
      autoCreate: autoCreate as number,
      aiCorroborate: aiCorroborate as number,
    };
  } catch {
    return {
      regexSkipAi: REGEX_CONFIDENCE_SKIP_AI_DEFAULT,
      autoCreate: AI_CONFIDENCE_AUTO_CREATE_DEFAULT,
      aiCorroborate: AI_CORROBORATION_CONFIDENCE_DEFAULT,
    };
  }
}

export interface ExtractionOutcome {
  status: MessageExtractionStatus;
  method: ExtractionMethod;
  candidateId?: string;
  confidence: number;
  matchedFields: string[];
  failureReason?: string;
  matchResult?: MatchResult['strength'];
  /** Merged regex+AI profile — persisted for the review/approve UI. */
  extractedProfile?: ExtractedProfile;
  /** Why the message needs review (drives the review-queue tabs). */
  reviewReason?: string;
  /** Existing candidate this profile may duplicate (name+age hit). */
  suspectedCandidateId?: string;
  /** Terminal failure — the reconciler must NOT retry it (a deterministic
   *  error like a schema-validation violation will fail identically forever).
   *  finalize() stamps retryCount to the cap so it lands straight in the
   *  manual-entry queue instead of looping on the AI. */
  permanent?: boolean;
}

/** Max automatic extraction attempts before a FAILED message is left for
 *  manual handling. Single source of truth — the reconciler imports this so
 *  the retry cap and the "exhausted → manual queue" boundary never drift. */
export const MAX_EXTRACTION_RETRIES = 3;

/** A Mongoose schema-validation failure (e.g. a field exceeding maxlength).
 *  Deterministic: retrying re-runs the SAME extraction and fails identically,
 *  so these must go terminal immediately rather than burn AI calls looping. */
function isValidationError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'ValidationError';
}

/**
 * The retry counter a finalize should persist:
 *   - non-FAILED outcome        → unchanged (a success/skip never counts).
 *   - permanent FAILED          → jump to the cap (reconciler stops retrying;
 *                                 lands in the manual-entry queue at once).
 *   - transient FAILED          → +1 (retried until the cap, then manual).
 * Exported (pure) so the retry/exhaustion contract is unit-tested directly.
 */
export function nextRetryCount(
  status: MessageExtractionStatus,
  priorRetries: number,
  permanent?: boolean,
): number {
  if (status !== MessageExtractionStatus.FAILED) return priorRetries;
  return permanent ? MAX_EXTRACTION_RETRIES : priorRetries + 1;
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

  const thresholds = await resolveThresholds();

  // Phase 7: fall back to media caption when body is empty. An
  // image-with-caption profile ("שדכנים — שרה בת 24…" with photo)
  // was previously silently ignored; now we extract from the caption.
  const effectiveText = (message.body?.trim() || message.mediaCaption?.trim() || '');
  flow.info(
    { messageId, contentType: message.contentType, textLen: effectiveText.length, preview: preview(effectiveText) },
    'flow_start',
  );
  if (!effectiveText) {
    // Image-only card (no body, no caption) — the dominant profile format
    // in many groups. Try vision extraction; the result ALWAYS goes to
    // needs_review (pixels have no regex corroboration), with the image
    // available to the reviewer via mediaUrl.
    const visionOutcome = await tryVisionExtraction(message);
    if (visionOutcome) return finalize(message, visionOutcome);

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
  if (match.strength === 'exact') {
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
  // A 'strong' (name + age±1) or 'weak' (name-only) hit is NOT auto-linked:
  // two different people routinely share a common Hebrew name and adjacent
  // age, and a silent merge makes the second person vanish. But we also don't
  // auto-CREATE past it — a name match is enough signal to send the message to
  // the duplicates review tab, where the operator decides link-to-existing vs
  // create-new (and sees any differing details side by side).
  let suspectedDuplicate = isNameMatch(match.strength) ? match.candidate : undefined;
  let suspectedStrength: MatchResult['strength'] | undefined = suspectedDuplicate ? match.strength : undefined;

  // ── 3. Decide whether to call AI ──────────────────────
  // Skip AI ONLY when regex already produced a RICH profile (name + some
  // free-text detail). Otherwise call AI — not just to classify, but to
  // ENRICH: fill the fields regex couldn't pull (occupation, family,
  // service, yeshiva, about, seeking). This is why sparse-but-confident
  // cards still go through AI. (Cost: more AI calls; OpenAI fallback + the
  // reconciler retry cover Groq rate limits.)
  // Substantial free text regex COULDN'T attach to a label (multi-line field
  // continuations, header-style labels, alt separators like " - ") lands in
  // unmatchedLines and is otherwise silently dropped. If there's a real amount
  // of it, the AI is the only thing that can recover it — so do NOT skip AI,
  // even when regex looks rich. Short decoration lines (בס"ד, כרטיס שידוך) are
  // excluded by the length floor; ≥2 real lines means regex left content on
  // the table (the shadchan/phone line alone is 1 and won't trip this).
  const droppedContentLines = regex.unmatchedLines.filter((l) => l.length >= 15).length;

  const regexRich =
    regex.confidence >= thresholds.regexSkipAi &&
    regex.isLikelyProfile &&
    !!profile.firstName &&
    (!!profile.about || !!profile.whatSeeking || !!profile.occupation) &&
    droppedContentLines < 2;

  if (regexRich) {
    flow.info({ messageId, droppedContentLines }, 'ai_skipped (regex already rich)');
  } else {
    flow.info({ messageId }, 'ai_calling');
    try {
      const ai = await extractProfileWithAI(effectiveText, { messageId: String(message._id) });
      flow.info({ messageId, isProfile: ai.profile.isProfile, aiConfidence: ai.profile.confidence }, 'ai_result');
      if (!ai.profile.isProfile) {
        // AI declined — override it ONLY when regex is at full-card
        // confidence (name + several core fields, same bar that would have
        // skipped AI entirely). A looser bar (any isLikelyProfile) let
        // announcement/contact cards that quote a few labels become
        // candidates against the AI's correct veto.
        if (regex.confidence >= thresholds.regexSkipAi && regex.isLikelyProfile && profile.firstName) {
          flow.info({ messageId }, 'ai_not_profile_overridden_by_regex (keeping regex data)');
        } else {
          flow.info({ messageId }, 'flow_stop: skipped_not_profile (AI says not a profile)');
          return finalize(message, {
            status: MessageExtractionStatus.SKIPPED_NOT_PROFILE,
            method: ExtractionMethod.AI,
            confidence: ai.profile.confidence,
            matchedFields: regex.matchedFields,
          });
        }
      } else {
      profile = mergeProfiles(regex.profile, ai.profile);
      combinedConfidence = Math.max(regex.confidence, ai.profile.confidence);
      method = ExtractionMethod.AI;

      // Re-match with the enriched profile (AI may have recovered a
      // name/phone the regex missed).
      match = await findExistingCandidate(profile);
      if (match.strength === 'exact') {
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
      if (isNameMatch(match.strength)) {
        suspectedDuplicate = match.candidate ?? suspectedDuplicate;
        suspectedStrength = match.strength;
      }
      } // end else (AI returned a profile)
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
      extractedProfile: profile,
      reviewReason: 'no_identifier',
    });
  }

  // Suspected duplicate person → ALWAYS a human decision, regardless of
  // confidence. The operator sees both cards side by side in the
  // duplicates tab and picks "same person — link" or "new person — create".
  if (suspectedDuplicate) {
    flow.info(
      { messageId, suspectedCandidateId: String(suspectedDuplicate._id), confidence: combinedConfidence },
      'flow_stop: needs_review (suspected duplicate — same name & age as an existing candidate)',
    );
    return finalize(message, {
      status: MessageExtractionStatus.NEEDS_REVIEW,
      method,
      confidence: combinedConfidence,
      matchedFields: Object.keys(profile),
      matchResult: suspectedStrength ?? 'weak',
      extractedProfile: profile,
      reviewReason: 'suspected_duplicate',
      suspectedCandidateId: String(suspectedDuplicate._id),
    });
  }

  // Injection guard: auto-create must be corroborated by DETERMINISTIC
  // signal (regex matched labeled fields / a phone), not by the model's
  // self-reported confidence alone. A crafted message that manipulates the
  // LLM into {"isProfile":true,"confidence":1} has no labeled card
  // structure, so it lands in needs_review for a human gate instead of
  // minting an ACTIVE candidate straight into the matching engine.
  //
  // Second corroboration path — STRUCTURED AI AGREEMENT. Many real cards use a
  // label-less positional format (e.g. "💫מאיר שמואל 💫26 💫נתניה 💫1.70"): the
  // regex parser keys on "label: value" and extracts NOTHING, so these perfect,
  // high-confidence AI reads used to pile up forever in needs_review with no way
  // out (the label-learner can't learn a format that has no labels). We accept
  // the AI's read as corroboration ONLY when it independently produced a
  // consistent CORE identity — name + age + (city or height) — at high
  // confidence. An injected free-text string won't coincidentally yield all of
  // those, so the injection guard's intent is preserved while our own formats
  // stop getting stuck. Tunable via 'extraction.ai_corroboration_confidence'.
  const aiCorroborated =
    method === ExtractionMethod.AI &&
    combinedConfidence >= thresholds.aiCorroborate &&
    !!profile.firstName &&
    !!profile.age &&
    (!!profile.city || !!profile.height);
  const deterministicSignal = regex.isLikelyProfile || regex.matchedFields.length >= 2 || aiCorroborated;
  const autoCreate = combinedConfidence >= thresholds.autoCreate && deterministicSignal;
  if (!autoCreate) {
    flow.info(
      {
        messageId,
        confidence: combinedConfidence,
        threshold: thresholds.autoCreate,
        deterministicSignal,
      },
      deterministicSignal
        ? 'flow_stop: needs_review (confidence below auto-create threshold → profile request)'
        : 'flow_stop: needs_review (AI confident but no deterministic corroboration — possible free-text/injected card)',
    );
    return finalize(message, {
      status: MessageExtractionStatus.NEEDS_REVIEW,
      method,
      confidence: combinedConfidence,
      matchedFields: Object.keys(profile),
      extractedProfile: profile,
      reviewReason: deterministicSignal ? 'low_confidence' : 'no_corroboration',
    });
  }

  let created: IExternalCandidate;
  try {
    created = await createFromProfile(profile, message);
  } catch (err) {
    // Lost the concurrent-repost race: a sibling message of the SAME person
    // (identical name+age) created the candidate microseconds earlier, and the
    // partial unique index on identityKey rejected this twin. Link to the
    // winner instead of failing — the operator sees one card, not three.
    const linked = isDuplicateKeyError(err)
      ? await linkToRaceWinner(profile, message)
      : null;
    if (linked) {
      flow.info({ messageId, candidateId: String(linked._id) }, 'flow_stop: matched_existing (identity-key race → linked)');
      return finalize(message, {
        status: MessageExtractionStatus.MATCHED_EXISTING,
        method,
        candidateId: String(linked._id),
        confidence: combinedConfidence,
        matchedFields: Object.keys(profile),
        matchResult: 'exact',
      });
    }
    // A non-duplicate create failure (most often a schema-validation error —
    // e.g. the AI bled free text into a length-capped field). Previously this
    // re-threw and ESCAPED finalize(), so the message stayed 'pending', the
    // reconciler re-enqueued it every 5 min, and it looped on the AI forever.
    // Instead: persist a FAILED outcome carrying the extracted fields, and for
    // deterministic validation errors mark it PERMANENT so it goes straight to
    // the manual-entry queue (no wasted retries) for the operator to fix by hand.
    const permanent = isValidationError(err);
    flow.warn(
      { messageId, error: (err as Error).message, permanent },
      permanent
        ? 'flow_stop: failed (permanent — invalid field, needs manual entry)'
        : 'flow_stop: failed (create error — will retry via reconciler)',
    );
    return finalize(message, {
      status: MessageExtractionStatus.FAILED,
      method,
      confidence: combinedConfidence,
      matchedFields: Object.keys(profile),
      failureReason: (err as Error).message,
      extractedProfile: profile,
      permanent,
    });
  }
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

/** A name-based match (strong = name+age±1, weak = name-only). Both route to
 *  the duplicates review tab rather than auto-create. 'exact' (name+phone) is
 *  handled separately (auto-link); 'none' means genuinely new. */
function isNameMatch(strength: MatchResult['strength']): boolean {
  return strength === 'strong' || strength === 'weak';
}

/** After an identityKey unique-index collision, find the candidate that won the
 *  race and link this message to it. Returns null if it can't be located (the
 *  caller then re-throws the original error). */
async function linkToRaceWinner(
  profile: ExtractedProfile,
  message: IMessage,
): Promise<IExternalCandidate | null> {
  const key = buildIdentityKey(profile.firstName, profile.lastName, profile.age);
  if (!key) return null;
  const winner = await ExternalCandidate.findOne({
    identityKey: key,
    archivedAt: { $exists: false },
  }).exec();
  if (!winner) return null;
  return linkToExisting(winner, message);
}

/**
 * Vision path for image-only cards. Returns a finalize-ready outcome, or
 * null when vision is unavailable / the message has no image / extraction
 * says not-a-profile with nothing usable. Vision profiles NEVER
 * auto-create — the human reviews them next to the image.
 */
async function tryVisionExtraction(message: IMessage): Promise<Omit<ExtractionOutcome, never> | null> {
  if (message.contentType !== 'image') return null;
  if (!(await visionExtractionAvailable())) return null;
  const messageId = String(message._id);

  // Ensure the image is on disk (ingest download may still be in flight —
  // downloadInboundMedia is idempotent, so awaiting it here is safe).
  let filename = message.mediaUrl?.split('/').pop();
  if (!filename) {
    const dl = await downloadInboundMedia(messageId);
    if (!dl.ok || !dl.filename) {
      flow.info({ messageId, reason: dl.reason }, 'vision_skipped (no media file)');
      return null;
    }
    filename = dl.filename;
  }

  try {
    flow.info({ messageId, filename }, 'vision_calling');
    const result = await extractProfileFromImage(filename);
    if (!result) return null;
    const ai = result.profile;
    if (!ai.isProfile) {
      flow.info({ messageId, confidence: ai.confidence }, 'flow_stop: skipped_not_profile (vision says not a profile)');
      return {
        status: MessageExtractionStatus.SKIPPED_NOT_PROFILE,
        method: ExtractionMethod.AI,
        confidence: ai.confidence,
        matchedFields: [],
      };
    }
    const profile = mergeProfiles({}, ai);
    flow.info(
      { messageId, confidence: ai.confidence, hasName: !!profile.firstName },
      'flow_stop: needs_review (vision-extracted image card → human gate)',
    );
    return {
      status: MessageExtractionStatus.NEEDS_REVIEW,
      method: ExtractionMethod.AI,
      confidence: ai.confidence,
      matchedFields: Object.keys(profile),
      extractedProfile: profile,
      reviewReason: 'vision_image',
    };
  } catch (err) {
    flow.warn({ messageId, error: (err as Error).message }, 'vision_failed');
    return {
      status: MessageExtractionStatus.FAILED,
      method: ExtractionMethod.AI,
      confidence: 0,
      matchedFields: [],
      failureReason: `vision: ${(err as Error).message}`,
    };
  }
}

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
  if (!out.service && ai.service) out.service = ai.service;
  if (!out.yeshiva && ai.yeshiva) out.yeshiva = ai.yeshiva;
  // Narrative free-text fields: regex grabs only the single labeled line, so
  // multi-line continuations ("אני מחפשת: …" + 3 lines below it, family with
  // "אבא… / אמא…") end up in the AI's fuller read. Prefer whichever is MORE
  // COMPLETE rather than always keeping regex's partial first line. (The AI
  // is told to condense only past ~1200 chars, so "longer" ≈ "more complete";
  // if the AI returned less, we keep regex — never a net loss.)
  out.occupation = pickFuller(out.occupation, ai.occupation);
  out.family = pickFuller(out.family, ai.family);
  out.about = pickFuller(out.about, ai.about);
  out.whatSeeking = pickFuller(out.whatSeeking, ai.whatSeeking);
  if (!out.seekingAgeMin && ai.seekingAgeMin) out.seekingAgeMin = ai.seekingAgeMin;
  if (!out.seekingAgeMax && ai.seekingAgeMax) out.seekingAgeMax = ai.seekingAgeMax;
  if ((!out.contactPhones || out.contactPhones.length === 0) && ai.contactPhones?.length) {
    out.contactPhones = ai.contactPhones;
  }
  return out;
}

/** Pick the more complete of two free-text values (longer wins; either may be
 *  undefined). Used for narrative fields where the AI's whole-card read tends
 *  to recover continuation lines the single-line regex grab missed. */
function pickFuller(regexVal?: string, aiVal?: string): string | undefined {
  if (!aiVal) return regexVal;
  if (!regexVal) return aiVal;
  return aiVal.length > regexVal.length ? aiVal : regexVal;
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
  const source = await resolveWhatsAppSource(message);
  const created = await ExternalCandidate.create({
    sourceType: ExternalSourceType.WHATSAPP_GROUP,
    sourceChannelId: message.channelId,
    sourceChatJid: message.chatJid,
    sourceGroupName: source.groupName,
    sourceSenderName: message.senderName,
    sourceSenderPhone: message.senderPhone,
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
    // Richer fields the regex/AI captured but that used to be dropped on
    // create — so the card carries the full detail from the source card.
    ethnicity: profile.edah,
    familyBackground: profile.family,
    currentOccupation: profile.occupation,
    educationInstitution: profile.yeshiva,
    armyService: profile.service,
    about: profile.about,
    whatSeeking: profile.whatSeeking,
    additionalInfo: profile.religiousLevelText,
    agePreferences: (profile.seekingAgeMin || profile.seekingAgeMax)
      ? { min: profile.seekingAgeMin, max: profile.seekingAgeMax }
      : undefined,
    status: ExternalCandidateStatus.ACTIVE,
    // A freshly-posted profile is, by definition, being offered for matches →
    // available. Without this it defaults to 'unknown' and is hidden by the
    // list's default "available" filter (operator "doesn't see new candidates").
    availabilityStatus: AvailabilityStatus.AVAILABLE,
  });

  // Attach the source card's image as the candidate photo NOW (R2 lifecycle
  // pipeline), not on the 30-min backfill sweep — so auto-created cards carry
  // their photo from the first render. Best-effort: never fails the create.
  try {
    await attachSourcePhotoToExternalCandidate(created);
  } catch (err) {
    flow.warn({ messageId: String(message._id), candidateId: String(created._id), err: (err as Error).message }, 'autocreate_photo_attach_failed');
  }

  // Seed the semantic embedding immediately, same as the manual-create path —
  // otherwise WhatsApp-extracted candidates never enter semantic matching
  // until an unrelated edit happens to trigger it. Also fires the manager
  // match-alert when armed. Fire-and-forget, gated.
  scheduleNewExternalCandidateAlert(String(created._id));

  return created;
}

// Resolve the human-readable WhatsApp group name for provenance. The group
// subject isn't on the message (only known live), but the operator's
// ChatMapping row carries chatName for mapped chats — use that.
async function resolveWhatsAppSource(message: IMessage): Promise<{ groupName?: string }> {
  if (!message.chatJid) return {};
  const mapping = await ChatMapping.findOne({ channelId: message.channelId, chatJid: message.chatJid })
    .select('chatName')
    .lean()
    .exec();
  return { groupName: mapping?.chatName ?? undefined };
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
  const retryCount = nextRetryCount(outcome.status, priorRetries, outcome.permanent);

  message.extraction = {
    status: outcome.status,
    method: outcome.method,
    attemptedAt: message.extraction?.attemptedAt ?? new Date(),
    completedAt: new Date(),
    candidateId: outcome.candidateId ? new Types.ObjectId(outcome.candidateId) : undefined,
    confidence: outcome.confidence,
    failureReason: outcome.failureReason,
    // Persist the permanent marker so the failed queue can route this to
    // manual entry (never requeue). Only meaningful on a FAILED outcome.
    permanentFailure: outcome.status === MessageExtractionStatus.FAILED ? !!outcome.permanent : undefined,
    matchedFields: outcome.matchedFields,
    retryCount,
    extractedProfile: outcome.extractedProfile as Record<string, unknown> | undefined,
    reviewReason: outcome.reviewReason,
    suspectedCandidateId: outcome.suspectedCandidateId
      ? new Types.ObjectId(outcome.suspectedCandidateId)
      : undefined,
    reviewClaimedAt: message.extraction?.reviewClaimedAt,
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
