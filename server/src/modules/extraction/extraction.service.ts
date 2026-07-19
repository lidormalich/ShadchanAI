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
import { processMessageExtraction, MAX_EXTRACTION_RETRIES } from '../../services/extraction/orchestrator.js';
import { enqueueExtraction } from '../../services/extraction/queue.js';
import { extractProfileFromText, type ExtractedProfile } from '../../services/extraction/regex.extractor.js';
import { ConflictError, NotFoundError, ValidationError, isDuplicateKeyError } from '../../utils/errors.js';
import { normalizePhone, mergePhoneEntries } from '../../utils/phone.js';
import { buildIdentityKey } from '../../utils/identity.js';
import { attachPendingDuplicates, type PendingDuplicate } from '../../services/extraction/queue-duplicates.js';
import { assignChatRole } from '../channels/channel.service.js';
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
        .select(
          'firstName lastName hebrewName gender age height city region neighborhood ' +
            'ethnicity sectorGroup personalStatus currentOccupation contactPhone ' +
            'availabilityStatus status',
        )
        .lean()
        .exec()
    : [];
  const suspectById = new Map(suspects.map((s) => [String(s._id), s]));

  // Batch-resolve the human-readable WhatsApp group name for each message's
  // chat, so the review card can show WHICH group a bad/duplicate card came
  // from (the operator uses this to spot and unmap a group that floods junk).
  // Keyed by channelId+chatJid — the same (unique) key ChatMapping is keyed on.
  const chatKey = (channelId: string, chatJid: string) => `${channelId}::${chatJid}`;
  const mappingPairs = [
    ...new Map(
      messages
        .filter((m) => m.chatJid)
        .map((m) => [chatKey(m.channelId, m.chatJid!), { channelId: m.channelId, chatJid: m.chatJid! }]),
    ).values(),
  ];
  const mappings = mappingPairs.length
    ? await ChatMapping.find({ $or: mappingPairs })
        .select('channelId chatJid chatName')
        .lean()
        .exec()
    : [];
  const groupNameByChat = new Map(
    mappings.map((cm) => [chatKey(cm.channelId, cm.chatJid), cm.chatName]),
  );

  const rows = messages.map((m) => {
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
      // WhatsApp provenance so the operator can trace a junk card to its group.
      sourceChatJid: m.chatJid,
      sourceGroupName: m.chatJid ? groupNameByChat.get(chatKey(m.channelId, m.chatJid)) : undefined,
      senderName: m.senderName,
      senderPhone: m.senderPhone,
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
            hebrewName: suspect.hebrewName,
            gender: suspect.gender,
            age: suspect.age,
            height: suspect.height,
            city: suspect.city,
            region: suspect.region,
            neighborhood: suspect.neighborhood,
            ethnicity: suspect.ethnicity,
            sectorGroup: suspect.sectorGroup,
            personalStatus: suspect.personalStatus,
            occupation: suspect.currentOccupation,
            contactPhone: suspect.contactPhone,
          }
        : undefined,
      // Other cards CURRENTLY in the queue that look like the same person —
      // filled in below. Lets the operator merge same-person reposts even when
      // none has become a candidate yet (so the matcher couldn't flag them).
      pendingDuplicates: [] as PendingDuplicate[],
    };
  });

  attachPendingDuplicates(rows);
  return rows;
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

// A failure reason that describes a DETERMINISTIC problem (bad/over-long
// field, wrong enum, cast error) — it will fail identically on every retry,
// so the card needs manual entry. Used as a fallback classifier for records
// that predate the persisted `permanentFailure` flag (e.g. a message that
// already failed before this flag existed) so they still route correctly.
export function isPermanentFailureReason(reason?: string): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return (
    r.includes('validation failed') ||
    r.includes('longer than the maximum allowed length') ||
    r.includes('is not a valid enum value') ||
    r.includes('cast to ') ||
    r.includes('is required')
  );
}

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
    const retryCount = m.extraction?.retryCount ?? 0;
    // Pre-fill the manual-entry form: prefer the pipeline's last merged
    // profile (the enrichment we already paid for), else a fresh regex read
    // of the body. Lets the operator fix the offending field and create the
    // candidate by hand instead of re-typing the whole card.
    const persisted = m.extraction?.extractedProfile as ExtractedProfile | undefined;
    const extractedFields = persisted ?? extractProfileFromText(effectiveText).profile ?? {};
    return {
      messageId: String(m._id),
      conversationId: String(m.conversationId),
      channelId: m.channelId,
      accountDisplayName: m.accountDisplayName,
      body: effectiveText || m.body,
      mediaUrl: m.mediaUrl,
      createdAt: m.createdAt,
      retryCount,
      // Exhausted = hit the retry cap → automatic retries are over.
      exhausted: retryCount >= MAX_EXTRACTION_RETRIES,
      // Permanent = a deterministic error (schema-validation etc.) that will
      // fail identically forever. These NEED manual entry and must never be
      // requeued — they drive the dedicated "failed candidates" page. A
      // transient failure (rate-limit / timeout) stays in the requeue tab.
      // Falls back to classifying by the reason text so records that failed
      // BEFORE the persisted flag existed still route to manual entry.
      permanent: !!m.extraction?.permanentFailure || isPermanentFailureReason(m.extraction?.failureReason),
      failureReason: m.extraction?.failureReason,
      extractedFields,
      attemptedAt: m.extraction?.attemptedAt,
      completedAt: m.extraction?.completedAt,
    };
  });
}

// ── Manual resolution of a permanently-failed card ───────
// The operator created a candidate by hand through the NORMAL external-
// candidate flow (nothing imported from this card). We then attach the
// original message to that candidate as its source — so the card is
// preserved and traceable — and move the message out of FAILED so it
// leaves the manual-entry queue.

export async function resolveFailedManually(
  messageId: string,
  candidateId: string,
): Promise<{ messageId: string; candidateId: string }> {
  if (!messageId || !Types.ObjectId.isValid(messageId)) {
    throw new ValidationError('Invalid messageId');
  }
  if (!candidateId || !Types.ObjectId.isValid(candidateId)) {
    throw new ValidationError('Invalid candidateId');
  }

  const message = await Message.findById(messageId).exec();
  if (!message) throw new NotFoundError('Message', messageId);
  if (message.extraction?.status !== MessageExtractionStatus.FAILED) {
    throw new ValidationError(
      `Message is not in a failed state (current: ${message.extraction?.status ?? 'none'})`,
    );
  }

  const candidate = await ExternalCandidate.findById(candidateId).exec();
  if (!candidate) throw new NotFoundError('ExternalCandidate', candidateId);

  // Attach the source card (deduped) so the manually-created candidate keeps
  // the original WhatsApp message as provenance.
  const ids = new Set((candidate.sourceMessageIds ?? []).map(String));
  if (!ids.has(String(message._id))) {
    candidate.sourceMessageIds = [...(candidate.sourceMessageIds ?? []), message._id as Types.ObjectId];
    candidate.lastSourceUpdateAt = message.createdAt;
    if (!candidate.sourceChannelId) candidate.sourceChannelId = message.channelId;
    if (!candidate.sourceChatJid && message.chatJid) candidate.sourceChatJid = message.chatJid;
    await candidate.save();
  }

  // Move the message out of FAILED so it leaves the manual-entry queue,
  // recording that it was resolved by a manual candidate creation.
  await updateMessageExtraction(message, {
    status: MessageExtractionStatus.MATCHED_EXISTING,
    method: ExtractionMethod.MANUAL,
    candidateId: candidate._id as Types.ObjectId,
  });

  log.info({ messageId, candidateId }, 'failed_card_resolved_manually');
  return { messageId: String(message._id), candidateId: String(candidate._id) };
}

// ── Delete a queued message (junk removal) ───────────────
// Hard-removes a message from the DB so it disappears from every queue —
// for spam / broadcasts / non-profiles the operator never wants to see
// again. Refused when the message already produced a candidate (that would
// orphan the candidate's source); those must be handled via the candidate
// instead. Defensively detaches from any candidate that referenced it.

export async function deleteQueuedMessage(messageId: string): Promise<{ deleted: boolean }> {
  if (!messageId || !Types.ObjectId.isValid(messageId)) {
    throw new ValidationError('Invalid messageId');
  }
  const message = await Message.findById(messageId).select('_id extraction.status').lean().exec();
  if (!message) throw new NotFoundError('Message', messageId);

  const status = message.extraction?.status;
  if (status === MessageExtractionStatus.CREATED_NEW || status === MessageExtractionStatus.MATCHED_EXISTING) {
    throw new ValidationError(
      'This message already produced a candidate — delete or edit the candidate instead of the message.',
    );
  }

  // Defensive: never leave a dangling source pointer behind.
  await ExternalCandidate.updateMany(
    { sourceMessageIds: message._id },
    { $pull: { sourceMessageIds: message._id } },
  ).exec();
  await Message.deleteOne({ _id: message._id }).exec();

  log.info({ messageId }, 'queued_message_deleted');
  return { deleted: true };
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

/**
 * Re-run extraction on every message still awaiting review (not mid-approval).
 * After teaching the parser new labels, this lets the operator shrink the queue
 * in one click — cards whose format is now understood auto-create/link instead
 * of waiting. Enqueued through the throttled queue so it won't blow AI limits;
 * most now parse via regex and skip AI entirely.
 */
export async function reprocessNeedsReview(limit = 1000): Promise<{ requeued: number }> {
  const capped = Math.min(limit || 1000, 2000);
  const msgs = await Message.find({
    'extraction.status': MessageExtractionStatus.NEEDS_REVIEW,
    'extraction.reviewClaimedAt': { $exists: false },
  }).select('_id').limit(capped).lean().exec();
  for (const m of msgs) {
    void enqueueExtraction(String(m._id)).catch(() => undefined);
  }
  log.info({ requeued: msgs.length }, 'reprocess_needs_review');
  return { requeued: msgs.length };
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
  //
  // Accept BOTH needs_review (the normal human-gate path) and failed (the
  // manual-entry queue): a message whose automatic extraction gave up after
  // the retry cap is created by hand from the same approve path, with the
  // operator's edited fields.
  const message = await Message.findOneAndUpdate(
    {
      _id: messageId,
      'extraction.status': { $in: [MessageExtractionStatus.NEEDS_REVIEW, MessageExtractionStatus.FAILED] },
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
    // Union the merged card's phones into the candidate instead of dropping
    // them — a repost often carries a DIFFERENT inquiry number, and losing it
    // on merge was the whole complaint. The candidate's own contactPhone is
    // seeded first so legacy cards (no phones array yet) keep their primary.
    const linkedProfile =
      (message.extraction?.extractedProfile as ExtractedProfile | undefined)
      ?? extractProfileFromText(message.body?.trim() || message.mediaCaption?.trim() || '').profile;
    const incomingPhones = linkedProfile.contactPhones ?? [];
    if (incomingPhones.length || candidate.contactPhone) {
      candidate.phones = mergePhoneEntries(
        mergePhoneEntries(
          candidate.phones,
          candidate.contactPhone ? [{ number: candidate.contactPhone, source: 'card' }] : [],
        ),
        incomingPhones.map((p) => ({ number: p, source: 'merged_card' })),
      );
    }
    // A candidate that never had a primary phone adopts the merged card's.
    if (!candidate.contactPhone && incomingPhones[0]) {
      candidate.contactPhone = incomingPhones[0];
      candidate.contactPhoneNormalized = normalizePhone(incomingPhones[0]) ?? undefined;
    }
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
  // Clamp the final profile to schema caps regardless of source — covers the
  // manual-entry case where the operator left an over-long AI-bled field
  // (e.g. occupation) untouched: without this the create would fail with the
  // very validation error that sent the card to the failed queue.
  const profile = clampProfileFields(
    bodyProfile ? mergeOverride(base, sanitizeProfileOverride(bodyProfile)) : base,
  );

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
      // Keep EVERY extracted phone, not just the primary — cards often list
      // several inquiry numbers (mother / father / shadchanit).
      phones: profile.contactPhones?.length
        ? mergePhoneEntries([], profile.contactPhones.map((p) => ({ number: p, source: 'card' })))
        : undefined,
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

// ── Ignore a source group ────────────────────────────────
// The operator spotted a WhatsApp group flooding junk/duplicate cards.
// Setting its ChatMapping role to 'ignore' makes the ingestion gate drop
// everything it sends FROM NOW ON (see message.handler resolveIngestionGate:
// effectiveRole 'ignore' → ignored_assigned_ignore, never enqueued).
//
// When `purgeQueued` is set, ALSO clear what already reached the review /
// duplicates tabs from that group: every still-pending (NEEDS_REVIEW) message
// with this (channelId, chatJid) is marked not-a-profile in one bulk write, so
// those cards leave the queue without minting candidates. The filter on
// NEEDS_REVIEW guarantees we never touch an already-approved message.
export async function ignoreSourceGroup(
  channelId: string,
  chatJid: string,
  performedBy: string,
  opts: { purgeQueued?: boolean; chatName?: string } = {},
): Promise<{ channelId: string; chatJid: string; role: 'ignore'; purged: number }> {
  if (!channelId?.trim() || !chatJid?.trim()) {
    throw new ValidationError('channelId and chatJid are required');
  }
  // WhatsApp group JIDs end in @g.us; anything else is a private chat.
  const chatType = chatJid.endsWith('@g.us') ? 'group' : 'private';
  await assignChatRole(channelId, chatJid, chatType, 'ignore', performedBy, opts.chatName);

  let purged = 0;
  if (opts.purgeQueued) {
    const res = await Message.updateMany(
      { channelId, chatJid, 'extraction.status': MessageExtractionStatus.NEEDS_REVIEW },
      {
        $set: {
          'extraction.status': MessageExtractionStatus.SKIPPED_NOT_PROFILE,
          'extraction.method': ExtractionMethod.MANUAL,
          'extraction.completedAt': new Date(),
        },
      },
    ).exec();
    purged = res.modifiedCount ?? 0;
  }

  log.info({ channelId, chatJid, purgeQueued: !!opts.purgeQueued, purged }, 'ignore_source_group');
  return { channelId, chatJid, role: 'ignore', purged };
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

// Candidate-schema string caps for the fields a profile can fill. Manual
// approval clamps to these so an operator's create never hard-fails on a
// maxlength violation — the same class of error that sends a card to the
// failed queue in the first place. Occupation is the tight one (200); the
// free-text fields are generous (2000).
const FIELD_MAX_LEN: Partial<Record<keyof ExtractedProfile, number>> = {
  occupation: 200,
  family: 2000,
  about: 2000,
  whatSeeking: 2000,
  religiousLevelText: 2000,
};

/** Trim every length-capped string field of a profile to its schema max, so
 *  a create/save can't fail on a maxlength violation. */
function clampProfileFields(profile: ExtractedProfile): ExtractedProfile {
  const out = { ...profile } as Record<string, unknown>;
  for (const [field, max] of Object.entries(FIELD_MAX_LEN)) {
    const v = out[field];
    if (typeof v === 'string' && v.length > max) out[field] = v.slice(0, max);
  }
  return out as ExtractedProfile;
}

function sanitizeProfileOverride(raw: Record<string, unknown>): ExtractedProfile {
  const clamp = (v: string, field: keyof ExtractedProfile): string => {
    const max = FIELD_MAX_LEN[field];
    return max && v.length > max ? v.slice(0, max) : v;
  };
  const str = (v: unknown, field?: keyof ExtractedProfile): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    if (t.length === 0) return undefined;
    return field ? clamp(t, field) : t;
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
    religiousLevelText: str(raw['religiousLevelText'], 'religiousLevelText'),
    personalStatus: enumVal<NonNullable<ExtractedProfile['personalStatus']>>(raw['personalStatus'], STATUS_VALUES),
    occupation: str(raw['occupation'], 'occupation'),
    family: str(raw['family'], 'family'),
    service: str(raw['service']),
    yeshiva: str(raw['yeshiva']),
    about: str(raw['about'], 'about'),
    whatSeeking: str(raw['whatSeeking'], 'whatSeeking'),
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
