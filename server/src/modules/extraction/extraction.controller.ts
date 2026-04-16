// ═══════════════════════════════════════════════════════════
// ShadchanAI — Extraction API
//
// Admin-facing endpoints for the profile-extraction pipeline:
//
//   POST /api/extraction/messages/:messageId/run
//     Synchronously (re-)runs extraction on one message and returns
//     the outcome. Used by the "עבד מחדש" button on a message bubble.
//
//   GET  /api/extraction/review-queue
//     Messages sitting in extraction.status=needs_review with the
//     extracted candidate skeleton — for the human reviewer UI.
//
//   POST /api/extraction/messages/:messageId/approve
//     Operator approves the pending extraction → creates the
//     ExternalCandidate from the last extraction attempt's fields.
//
//   POST /api/extraction/messages/:messageId/reject
//     Operator marks the message as NOT a profile (stops the pipeline
//     from re-queueing it).
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import {
  ExtractionMethod,
  ExternalCandidateStatus,
  ExternalSourceType,
  MessageExtractionStatus,
} from '@shadchanai/shared';
import { Message, ExternalCandidate, type IMessage } from '../../models/index.js';
import { processMessageExtraction } from '../../services/extraction/orchestrator.js';
import { extractProfileFromText, type ExtractedProfile } from '../../services/extraction/regex.extractor.js';
import { ensureUser, canManageChannels } from '../../middleware/permissions.js';
import { ok } from '../../utils/response.js';
import { NotFoundError, ValidationError, ConflictError } from '../../utils/errors.js';
import { normalizePhone } from '../../utils/phone.js';
import { recordDuplicatePhone } from '../../services/monitoring/metrics.service.js';

// ── Synchronous manual (re-)run ──────────────────────────

export async function runHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const messageId = String(req.params['messageId'] ?? '');
    if (!messageId || !Types.ObjectId.isValid(messageId)) {
      throw new ValidationError('Invalid messageId');
    }
    const outcome = await processMessageExtraction(messageId);
    ok(res, outcome);
  } catch (e) { next(e); }
}

// ── Review queue ─────────────────────────────────────────

export async function reviewQueueHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const limit = Math.min(Number(req.query['limit']) || 50, 200);

    const messages = await Message.find({
      'extraction.status': MessageExtractionStatus.NEEDS_REVIEW,
    })
      .sort({ 'extraction.completedAt': -1 })
      .limit(limit)
      .lean()
      .exec();

    // Re-run regex on each to surface the extracted skeleton without
    // persisting. AI fields are NOT recomputed here — we rely on the
    // last async run's output.
    const items = messages.map((m) => {
      const regex = extractProfileFromText(m.body ?? '');
      return {
        messageId: String(m._id),
        conversationId: String(m.conversationId),
        channelId: m.channelId,
        accountDisplayName: m.accountDisplayName,
        body: m.body,
        createdAt: m.createdAt,
        extraction: m.extraction,
        extractedFields: regex.profile,
        regexConfidence: regex.confidence,
      };
    });

    ok(res, items);
  } catch (e) { next(e); }
}

// ── Approve (create candidate from last extraction) ──────

export async function approveHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const messageId = String(req.params['messageId'] ?? '');
    if (!messageId || !Types.ObjectId.isValid(messageId)) {
      throw new ValidationError('Invalid messageId');
    }

    const message = await Message.findById(messageId).exec();
    if (!message) throw new NotFoundError('Message', messageId);
    if (message.extraction?.status !== MessageExtractionStatus.NEEDS_REVIEW) {
      throw new ValidationError(`Message is not in needs_review (current: ${message.extraction?.status ?? 'none'})`);
    }

    // If the operator edited the fields in the review UI they're sent
    // on the request body as `profile`. We take those verbatim and skip
    // re-running the regex so their corrections aren't overwritten.
    // When no override is supplied we fall back to the regex output.
    const bodyProfile = (req.body as { profile?: Record<string, unknown> } | undefined)?.profile;
    const profile = bodyProfile
      ? sanitizeProfileOverride(bodyProfile)
      : extractProfileFromText(message.body ?? '').profile;

    if (!profile.firstName && !profile.contactPhones?.length) {
      throw new ValidationError('No name or phone extracted — cannot create candidate. Reject instead.');
    }

    const primaryPhone = profile.contactPhones?.[0];
    const normalizedPhone = normalizePhone(primaryPhone);

    // Duplicate guard at approve-time: if another active external
    // already holds this canonical phone, refuse with a structured
    // 409 so the operator can open the existing candidate instead
    // of silently creating a twin.
    if (normalizedPhone) {
      const existing = await ExternalCandidate.findOne({
        contactPhoneNormalized: normalizedPhone,
        archivedAt: { $exists: false },
      }).select('_id firstName lastName').lean().exec();
      if (existing) {
        recordDuplicatePhone({ source: 'extraction_approve', existingCandidateId: String(existing._id), messageId });
        throw new ConflictError(
          'An external candidate with this phone already exists',
          { code: 'duplicate_phone', existingCandidateId: String(existing._id) },
        );
      }
    }

    const created = await ExternalCandidate.create({
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
      importedBy: new Types.ObjectId(user.id),
      // The operator who approved the extraction becomes the owner.
      ownerUserId: new Types.ObjectId(user.id),
    });

    await updateMessageExtraction(message, {
      status: MessageExtractionStatus.CREATED_NEW,
      method: ExtractionMethod.MANUAL,
      candidateId: created._id as Types.ObjectId,
    });

    ok(res, { candidateId: String(created._id), messageId: String(message._id) });
  } catch (e) { next(e); }
}

// ── Reject (mark as not-a-profile) ───────────────────────

export async function rejectHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const messageId = String(req.params['messageId'] ?? '');
    if (!messageId || !Types.ObjectId.isValid(messageId)) {
      throw new ValidationError('Invalid messageId');
    }
    const message = await Message.findById(messageId).exec();
    if (!message) throw new NotFoundError('Message', messageId);

    await updateMessageExtraction(message, {
      status: MessageExtractionStatus.SKIPPED_NOT_PROFILE,
      method: ExtractionMethod.MANUAL,
    });
    ok(res, { messageId: String(message._id), status: MessageExtractionStatus.SKIPPED_NOT_PROFILE });
  } catch (e) { next(e); }
}

// ── Helpers ──────────────────────────────────────────────

// Whitelist & coerce the fields we accept from the operator review UI.
// Anything outside this shape is dropped — avoids accidental persistence
// of fields the ExternalCandidate schema doesn't know about.
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
  const phones = Array.isArray(raw['contactPhones'])
    ? (raw['contactPhones'] as unknown[]).map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0)
    : undefined;

  return {
    firstName: str(raw['firstName']),
    lastName: str(raw['lastName']),
    gender: str(raw['gender']) as ExtractedProfile['gender'],
    age: num(raw['age']),
    height: num(raw['height']),
    city: str(raw['city']),
    edah: str(raw['edah']),
    sectorGroup: str(raw['sectorGroup']) as ExtractedProfile['sectorGroup'],
    personalStatus: str(raw['personalStatus']) as ExtractedProfile['personalStatus'],
    occupation: str(raw['occupation']),
    about: str(raw['about']),
    whatSeeking: str(raw['whatSeeking']),
    seekingAgeMin: num(raw['seekingAgeMin']),
    seekingAgeMax: num(raw['seekingAgeMax']),
    contactPhones: phones && phones.length > 0 ? phones : undefined,
  };
}

async function updateMessageExtraction(
  message: IMessage,
  patch: { status: MessageExtractionStatus; method: ExtractionMethod; candidateId?: Types.ObjectId },
): Promise<void> {
  message.extraction = {
    status: patch.status,
    method: patch.method,
    attemptedAt: message.extraction?.attemptedAt ?? new Date(),
    completedAt: new Date(),
    candidateId: patch.candidateId,
    confidence: message.extraction?.confidence,
    matchedFields: message.extraction?.matchedFields,
  };
  await message.save();
}
