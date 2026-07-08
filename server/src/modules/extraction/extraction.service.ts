// ═══════════════════════════════════════════════════════════
// Extraction service — business logic & model access for the
// profile-extraction admin pipeline.
//
// Holds: manual (re-)run, review-queue listing, ingestion log,
// approve (ExternalCandidate creation + duplicate-phone guard),
// reject, and the private profile-override / message-patch helpers
// that previously lived in the controller.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import {
  AvailabilityStatus,
  ChannelRole,
  ExtractionMethod,
  ExternalCandidateStatus,
  ExternalSourceType,
  Gender,
  MessageDirection,
  MessageExtractionStatus,
  MessageIngestionDecision,
  PersonalStatus,
  SectorGroup,
} from '@shadchanai/shared';
import { Message, ExternalCandidate, ChatMapping, type IMessage } from '../../models/index.js';
import { processMessageExtraction } from '../../services/extraction/orchestrator.js';
import { enqueueExtraction } from '../../services/extraction/queue.js';
import { extractProfileFromText, type ExtractedProfile } from '../../services/extraction/regex.extractor.js';
import { ConflictError, NotFoundError, ValidationError, isDuplicateKeyError } from '../../utils/errors.js';
import { normalizePhone } from '../../utils/phone.js';
import { buildIdentityKey } from '../../utils/identity.js';
import { recordDuplicatePhone } from '../../services/monitoring/metrics.service.js';
import { attachSourcePhotoToExternalCandidate, runExternalPhotoBackfillNow } from '../../services/storage/photo-maintenance.service.js';
import { scheduleNewExternalCandidateAlert } from '../../services/notifications/new-match-alert.service.js';
import { startSemanticBackfill } from '../../services/embedding/semantic-backfill.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('extraction-service');

// ── Synchronous manual (re-)run ──────────────────────────

export async function runExtraction(messageId: string): Promise<Awaited<ReturnType<typeof processMessageExtraction>>> {
  if (!messageId || !Types.ObjectId.isValid(messageId)) {
    throw new ValidationError('Invalid messageId');
  }
  return processMessageExtraction(messageId);
}

// ── "רענן כללי" — one-click refresh of the smart processing ──
// Backfills photos for every existing candidate that predates the inline
// attach (visible, synchronous), then kicks the background semantic backfill
// so vectors are (re)built too. Both are idempotent and each is independently
// gated (R2 for photos, the semantic toggle for embeddings).

export async function refreshAllCandidateData(): Promise<{
  photosScanned: number;
  photosAttached: number;
  semanticStarted: boolean;
}> {
  const photos = await runExternalPhotoBackfillNow();

  let semanticStarted = false;
  try {
    const s = await startSemanticBackfill();
    semanticStarted = s.status === 'running' || s.status === 'done';
  } catch (err) {
    // Semantic toggle is off (or another expected gate) — photos still ran.
    log.info({ reason: (err as Error).message }, 'refresh_all_semantic_skipped');
  }

  log.info({ ...photos, semanticStarted }, 'refresh_all_done');
  return { photosScanned: photos.scanned, photosAttached: photos.attached, semanticStarted };
}

// ── Review queue ─────────────────────────────────────────

export async function listReviewQueue(limit: number): Promise<unknown[]> {
  const capped = Math.min(limit || 50, 200);
  const messages = await Message.find({
    'extraction.status': MessageExtractionStatus.NEEDS_REVIEW,
  })
    .sort({ 'extraction.completedAt': -1 })
    .limit(capped)
    .lean()
    .exec();

  // Prefer the PERSISTED merged regex+AI profile from the last async run —
  // that's the enrichment the pipeline already paid for. Regex re-run is
  // only the fallback for legacy messages extracted before persistence.
  // Batch-load suspected-duplicate candidates for the side-by-side compare
  // in the duplicates tab.
  const suspectIds = [
    ...new Set(
      messages
        .map((m) => m.extraction?.suspectedCandidateId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const suspects = suspectIds.length
    ? await ExternalCandidate.find({ _id: { $in: suspectIds } })
        .select('firstName lastName age city sectorGroup personalStatus contactPhone availabilityStatus status')
        .lean()
        .exec()
    : [];
  const suspectById = new Map(suspects.map((s) => [String(s._id), s]));

  return messages.map((m) => {
    // Caption-only profiles (image card with text caption) must review the
    // same text the orchestrator extracted from — not just `body`.
    const effectiveText = m.body?.trim() || m.mediaCaption?.trim() || '';
    const persisted = m.extraction?.extractedProfile as ExtractedProfile | undefined;
    // Always run regex — even when a persisted profile exists — so the review
    // card can surface the lines the parser did NOT recognize (unmatchedLines).
    // Those are the operator's cue to teach a new label→field mapping (the
    // card-label dictionary), which shrinks the queue over time.
    const regex = extractProfileFromText(effectiveText);
    const suspectId = m.extraction?.suspectedCandidateId
      ? String(m.extraction.suspectedCandidateId)
      : undefined;
    const suspect = suspectId ? suspectById.get(suspectId) : undefined;
    return {
      messageId: String(m._id),
      conversationId: String(m.conversationId),
      channelId: m.channelId,
      accountDisplayName: m.accountDisplayName,
      body: effectiveText || m.body,
      mediaUrl: m.mediaUrl,
      createdAt: m.createdAt,
      extraction: m.extraction,
      extractedFields: persisted ?? regex.profile ?? {},
      regexConfidence: persisted ? m.extraction?.confidence : regex.confidence,
      // Lines the deterministic parser couldn't attach to a known label —
      // candidate labels for the operator to teach (Feature C).
      unmatchedLines: regex.unmatchedLines,
      reviewReason: m.extraction?.reviewReason,
      suspectedCandidate: suspect
        ? {
            id: String(suspect._id),
            firstName: suspect.firstName,
            lastName: suspect.lastName,
            age: suspect.age,
            city: suspect.city,
            sectorGroup: suspect.sectorGroup,
            personalStatus: suspect.personalStatus,
            contactPhone: suspect.contactPhone,
          }
        : undefined,
    };
  });
}

// ── Failed queue (extractions that fell — usually rate-limit) ──
// Every profiles_source inbound message whose extraction ended in FAILED,
// with retryCount (how many times it fell) and the failure reason, so the
// operator can see the casualties and push them back into the pipeline.

const FAILED_SCOPE = {
  channelRole: ChannelRole.PROFILES_SOURCE,
  direction: MessageDirection.INBOUND,
  'extraction.status': MessageExtractionStatus.FAILED,
} as const;

export async function listFailedQueue(limit: number): Promise<unknown[]> {
  const capped = Math.min(limit || 50, 200);
  const messages = await Message.find(FAILED_SCOPE)
    .sort({ 'extraction.completedAt': -1 })
    .limit(capped)
    .select('_id conversationId channelId accountDisplayName body mediaCaption mediaUrl createdAt extraction')
    .lean()
    .exec();

  return messages.map((m) => {
    const effectiveText = m.body?.trim() || m.mediaCaption?.trim() || '';
    return {
      messageId: String(m._id),
      conversationId: String(m.conversationId),
      channelId: m.channelId,
      accountDisplayName: m.accountDisplayName,
      body: effectiveText || m.body,
      mediaUrl: m.mediaUrl,
      createdAt: m.createdAt,
      retryCount: m.extraction?.retryCount ?? 0,
      failureReason: m.extraction?.failureReason,
      attemptedAt: m.extraction?.attemptedAt,
      completedAt: m.extraction?.completedAt,
    };
  });
}

/**
 * Push one failed (or otherwise stuck) message back into the live extraction
 * queue. Clears the retry cap so a message the reconciler already gave up on
 * gets a fresh set of attempts, then enqueues it — the queue's cooldown +
 * spacing keep the retry from re-blowing the AI rate limit.
 */
export async function requeueExtraction(messageId: string): Promise<{ messageId: string; queued: boolean }> {
  if (!messageId || !Types.ObjectId.isValid(messageId)) {
    throw new ValidationError('Invalid messageId');
  }
  const exists = await Message.exists({ _id: messageId });
  if (!exists) throw new NotFoundError('Message', messageId);
  await Message.updateOne(
    { _id: messageId },
    { $set: { 'extraction.retryCount': 0 }, $unset: { 'extraction.failureReason': '' } },
  ).exec();
  await enqueueExtraction(messageId);
  return { messageId, queued: true };
}

/** Bulk "requeue all" — same reset + enqueue for every currently-failed message. */
export async function requeueAllFailed(limit = 500): Promise<{ requeued: number }> {
  const capped = Math.min(limit || 500, 1000);
  const failed = await Message.find(FAILED_SCOPE).select('_id').limit(capped).lean().exec();
  for (const m of failed) {
    await Message.updateOne(
      { _id: m._id },
      { $set: { 'extraction.retryCount': 0 }, $unset: { 'extraction.failureReason': '' } },
    ).exec();
    void enqueueExtraction(String(m._id)).catch(() => undefined);
  }
  log.info({ requeued: failed.length }, 'requeue_all_failed');
  return { requeued: failed.length };
}

// ── Ingestion log (what arrived & how it was routed) ─────

const IGNORED_DECISIONS = [
  MessageIngestionDecision.IGNORED_ASSIGNED_IGNORE,
  MessageIngestionDecision.IGNORED_MATCH_SENDING,
  MessageIngestionDecision.IGNORED_UNMAPPED,
] as const;

export async function listIngestionLog(limit: number, decisionParam: string): Promise<unknown[]> {
  const capped = Math.min(limit || 50, 200);

  // Default view = the filtered-out messages (the operator's blind spot).
  // ?decision=<value> narrows to one; ?decision=all includes accepted too.
  let decisionFilter: Record<string, unknown>;
  if (decisionParam === 'all') {
    decisionFilter = { 'ingestion.decision': { $exists: true } };
  } else if ((Object.values(MessageIngestionDecision) as string[]).includes(decisionParam)) {
    decisionFilter = { 'ingestion.decision': decisionParam };
  } else {
    decisionFilter = { 'ingestion.decision': { $in: IGNORED_DECISIONS } };
  }

  const messages = await Message.find(decisionFilter)
    .sort({ 'ingestion.decidedAt': -1 })
    .limit(capped)
    .select('_id conversationId channelId accountDisplayName body createdAt ingestion extraction')
    .lean()
    .exec();

  return messages.map((m) => ({
    messageId: String(m._id),
    conversationId: String(m.conversationId),
    channelId: m.channelId,
    accountDisplayName: m.accountDisplayName,
    body: m.body,
    createdAt: m.createdAt,
    ingestion: m.ingestion
      ? {
          decision: m.ingestion.decision,
          effectiveRole: m.ingestion.effectiveRole,
          decidedAt: m.ingestion.decidedAt,
        }
      : undefined,
    extractionStatus: m.extraction?.status,
  }));
}

// ── Approve (create candidate from last extraction) ──────

export async function approveExtraction(
  messageId: string,
  bodyProfile: Record<string, unknown> | undefined,
  userId: string,
  opts: { linkToCandidateId?: string } = {},
): Promise<{ candidateId: string; messageId: string; linked?: boolean }> {
  if (!messageId || !Types.ObjectId.isValid(messageId)) {
    throw new ValidationError('Invalid messageId');
  }

  // Atomic claim: only the FIRST approve request flips reviewClaimedAt.
  // A double-click or a second operator gets a clean conflict error
  // instead of creating a twin candidate.
  const message = await Message.findOneAndUpdate(
    {
      _id: messageId,
      'extraction.status': MessageExtractionStatus.NEEDS_REVIEW,
      'extraction.reviewClaimedAt': { $exists: false },
    },
    { $set: { 'extraction.reviewClaimedAt': new Date() } },
    { new: true },
  ).exec();
  if (!message) {
    const existing = await Message.findById(messageId).select('extraction.status').lean().exec();
    if (!existing) throw new NotFoundError('Message', messageId);
    throw new ValidationError(
      `Message is not awaiting review or is already being approved (current: ${existing.extraction?.status ?? 'none'})`,
    );
  }

  try {
    return await approveClaimed(message, bodyProfile, userId, opts);
  } catch (err) {
    // Release the claim so the operator can retry after fixing the input.
    await Message.updateOne(
      { _id: message._id },
      { $unset: { 'extraction.reviewClaimedAt': '' } },
    ).exec().catch(() => undefined);
    throw err;
  }
}

async function approveClaimed(
  message: IMessage,
  bodyProfile: Record<string, unknown> | undefined,
  userId: string,
  opts: { linkToCandidateId?: string },
): Promise<{ candidateId: string; messageId: string; linked?: boolean }> {
  // Duplicates-tab decision: "same person" → link the message to the
  // existing candidate instead of creating a new one.
  if (opts.linkToCandidateId) {
    if (!Types.ObjectId.isValid(opts.linkToCandidateId)) {
      throw new ValidationError('Invalid linkToCandidateId');
    }
    const candidate = await ExternalCandidate.findById(opts.linkToCandidateId).exec();
    if (!candidate) throw new NotFoundError('ExternalCandidate', opts.linkToCandidateId);
    const ids = new Set((candidate.sourceMessageIds ?? []).map(String));
    if (!ids.has(String(message._id))) {
      candidate.sourceMessageIds = [
        ...(candidate.sourceMessageIds ?? []),
        message._id as Types.ObjectId,
      ];
    }
    candidate.lastSourceUpdateAt = message.createdAt;
    await candidate.save();
    await updateMessageExtraction(message, {
      status: MessageExtractionStatus.MATCHED_EXISTING,
      method: ExtractionMethod.MANUAL,
      candidateId: candidate._id as Types.ObjectId,
    });
    return { candidateId: String(candidate._id), messageId: String(message._id), linked: true };
  }

  // Base = the persisted merged regex+AI profile from the async run (the
  // enrichment we already paid for); regex on the effective text is only
  // the legacy fallback. Operator edits from the review UI override
  // field-by-field — fields the form doesn't render (family, service,
  // yeshiva, religiousLevelText) survive from the base instead of being
  // silently dropped.
  const effectiveText = message.body?.trim() || message.mediaCaption?.trim() || '';
  const base =
    (message.extraction?.extractedProfile as ExtractedProfile | undefined)
    ?? extractProfileFromText(effectiveText).profile;
  const profile = bodyProfile ? mergeOverride(base, sanitizeProfileOverride(bodyProfile)) : base;

  if (!profile.firstName && !profile.contactPhones?.length) {
    throw new ValidationError('No name or phone extracted — cannot create candidate. Reject instead.');
  }

  const primaryPhone = profile.contactPhones?.[0];
  const normalizedPhone = normalizePhone(primaryPhone);

  // NOTE: we do NOT block approval on a shared phone. In shidduch posts the
  // number is usually the shadchan's "inquiries" line (טלפון לבירורים), shared
  // across many different candidates — blocking would drop legitimate distinct
  // people. Policy: prefer a duplicate over a miss. We still record the phone
  // collision as a soft signal so duplicates can be reviewed/merged later.
  if (normalizedPhone) {
    const existing = await ExternalCandidate.findOne({
      contactPhoneNormalized: normalizedPhone,
      archivedAt: { $exists: false },
    }).select('_id').lean().exec();
    if (existing) {
      recordDuplicatePhone({ source: 'extraction_approve', existingCandidateId: String(existing._id), messageId: String(message._id) });
    }
  }

  // WhatsApp provenance: which group + who posted it.
  const groupName = message.chatJid
    ? (await ChatMapping.findOne({ channelId: message.channelId, chatJid: message.chatJid })
        .select('chatName').lean().exec())?.chatName ?? undefined
    : undefined;

  let created;
  try {
    created = await ExternalCandidate.create({
      sourceType: ExternalSourceType.WHATSAPP_GROUP,
      sourceChannelId: message.channelId,
      sourceChatJid: message.chatJid,
      sourceGroupName: groupName,
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
      // Freshly-posted profile → available (else hidden by the list's default
      // "available" filter). Operator can change it later.
      availabilityStatus: AvailabilityStatus.AVAILABLE,
      importedBy: new Types.ObjectId(userId),
      // The operator who approved the extraction becomes the owner.
      ownerUserId: new Types.ObjectId(userId),
    });
  } catch (err) {
    // Same-identity (name+age) candidate already exists — the unique index
    // rejected this create. Point the operator at the existing card so they can
    // link via the duplicates tab instead of minting a twin. (The outer
    // approveExtraction releases the review claim so they can retry.)
    if (isDuplicateKeyError(err)) {
      throw new ConflictError(
        'A candidate with the same name and age already exists — link to it instead of creating a duplicate',
        { code: 'duplicate_identity', existingCandidateId: await findIdentityDuplicateId(profile) },
      );
    }
    throw err;
  }

  await updateMessageExtraction(message, {
    status: MessageExtractionStatus.CREATED_NEW,
    method: ExtractionMethod.MANUAL,
    candidateId: created._id as Types.ObjectId,
  });

  // Pull the source card's image into the candidate's photo NOW (via the R2
  // lifecycle pipeline) rather than leaving it for the 30-min backfill sweep —
  // so an approved image card shows its photo immediately. Best-effort: a
  // failure here never fails the approval (the sweep is the safety net).
  try {
    await attachSourcePhotoToExternalCandidate(created);
  } catch (err) {
    log.warn({ candidateId: String(created._id), err: (err as Error).message }, 'approve_photo_attach_failed');
  }

  // Seed the semantic embedding immediately, same as the manual-create path —
  // otherwise approved candidates skip semantic matching. Also fires the
  // manager match-alert when armed. Fire-and-forget, gated.
  scheduleNewExternalCandidateAlert(String(created._id));

  return { candidateId: String(created._id), messageId: String(message._id) };
}

// ── Reject (mark as not-a-profile) ───────────────────────

export async function rejectExtraction(
  messageId: string,
): Promise<{ messageId: string; status: MessageExtractionStatus }> {
  if (!messageId || !Types.ObjectId.isValid(messageId)) {
    throw new ValidationError('Invalid messageId');
  }
  const message = await Message.findById(messageId).exec();
  if (!message) throw new NotFoundError('Message', messageId);

  // Only a message actually awaiting review can be rejected. Without this
  // guard, rejecting an already-approved message flipped CREATED_NEW →
  // SKIPPED_NOT_PROFILE and severed the created candidate's provenance.
  if (message.extraction?.status !== MessageExtractionStatus.NEEDS_REVIEW) {
    throw new ValidationError(
      `Message is not awaiting review (current: ${message.extraction?.status ?? 'none'})`,
    );
  }

  await updateMessageExtraction(message, {
    status: MessageExtractionStatus.SKIPPED_NOT_PROFILE,
    method: ExtractionMethod.MANUAL,
  });
  return { messageId: String(message._id), status: MessageExtractionStatus.SKIPPED_NOT_PROFILE };
}

// ── Helpers ──────────────────────────────────────────────

/** Locate the active candidate that owns this profile's identity key, so a
 *  duplicate-create conflict can name the card to link to. */
async function findIdentityDuplicateId(profile: ExtractedProfile): Promise<string | undefined> {
  const key = buildIdentityKey(profile.firstName, profile.lastName, profile.age);
  if (!key) return undefined;
  const existing = await ExternalCandidate.findOne({ identityKey: key, archivedAt: { $exists: false } })
    .select('_id')
    .lean()
    .exec();
  return existing ? String(existing._id) : undefined;
}

// Whitelist & coerce the fields we accept from the operator review UI.
// Anything outside this shape is dropped — avoids accidental persistence
// of fields the ExternalCandidate schema doesn't know about. Enum fields
// are validated against the shared enums so an invalid UI value degrades
// to undefined (kept from the base profile) instead of a Mongoose 500.
const GENDER_VALUES = Object.values(Gender) as string[];
const SECTOR_VALUES = Object.values(SectorGroup) as string[];
const STATUS_VALUES = Object.values(PersonalStatus) as string[];

function sanitizeProfileOverride(raw: Record<string, unknown>): ExtractedProfile {
  const str = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  };
  const num = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return undefined;
  };
  const enumVal = <T extends string>(v: unknown, allowed: string[]): T | undefined => {
    const t = str(v);
    return t && allowed.includes(t) ? (t as T) : undefined;
  };
  const phones = Array.isArray(raw['contactPhones'])
    ? (raw['contactPhones'] as unknown[]).map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0)
    : undefined;

  return {
    firstName: str(raw['firstName']),
    lastName: str(raw['lastName']),
    gender: enumVal<NonNullable<ExtractedProfile['gender']>>(raw['gender'], GENDER_VALUES),
    age: num(raw['age']),
    height: num(raw['height']),
    city: str(raw['city']),
    edah: str(raw['edah']),
    sectorGroup: enumVal<NonNullable<ExtractedProfile['sectorGroup']>>(raw['sectorGroup'], SECTOR_VALUES),
    religiousLevelText: str(raw['religiousLevelText']),
    personalStatus: enumVal<NonNullable<ExtractedProfile['personalStatus']>>(raw['personalStatus'], STATUS_VALUES),
    occupation: str(raw['occupation']),
    family: str(raw['family']),
    service: str(raw['service']),
    yeshiva: str(raw['yeshiva']),
    about: str(raw['about']),
    whatSeeking: str(raw['whatSeeking']),
    seekingAgeMin: num(raw['seekingAgeMin']),
    seekingAgeMax: num(raw['seekingAgeMax']),
    contactPhones: phones && phones.length > 0 ? phones : undefined,
  };
}

// Field-by-field override merge: a defined override field wins; an
// undefined one keeps the base value. (Deliberate consequence: the review
// form can't blank a field — it can only change it. Clearing curated data
// stays an explicit candidate-edit action.)
function mergeOverride(base: ExtractedProfile, override: ExtractedProfile): ExtractedProfile {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) out[k] = v;
  }
  return out as ExtractedProfile;
}

async function updateMessageExtraction(
  message: IMessage,
  patch: { status: MessageExtractionStatus; method: ExtractionMethod; candidateId?: Types.ObjectId },
): Promise<void> {
  // Spread the existing subdoc so audit fields (retryCount, extractedProfile,
  // reviewReason, suspectedCandidateId, confidence) survive the transition.
  message.extraction = {
    ...(message.extraction ?? {}),
    status: patch.status,
    method: patch.method,
    attemptedAt: message.extraction?.attemptedAt ?? new Date(),
    completedAt: new Date(),
    candidateId: patch.candidateId ?? message.extraction?.candidateId,
  };
  await message.save();
}
