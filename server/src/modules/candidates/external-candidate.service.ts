// ═══════════════════════════════════════════════════════════
// ShadchanAI — External Candidate Service
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import {
  AuditActionType,
  AuditEntityType,
  ExternalCandidateStatus,
} from '@shadchanai/shared';
import {
  ExternalCandidate,
  InternalCandidate,
  MatchSuggestion,
  Message,
  type IExternalCandidate,
} from '../../models/index.js';
import { audit } from '../../services/audit.service.js';
import { NotFoundError, BusinessRuleError, ConflictError, isDuplicateKeyError } from '../../utils/errors.js';
import { buildIdentityKey } from '../../utils/identity.js';
import { toSkipLimit, buildSort, makeMeta } from '../../utils/pagination.js';
import { applyOwnershipFilter } from '../../utils/ownership.js';
import { assertOwnership } from '../../utils/ownership.assert.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';
import { normalizePhone, mergePhoneEntries } from '../../utils/phone.js';
import { isStorageEnabled } from '../../services/storage/storage.service.js';
import {
  syncCandidatePhoto,
  deleteCandidatePhoto,
  generatePhotoShareToken,
} from '../../services/storage/candidate-photo.service.js';
import { recordDuplicatePhone } from '../../services/monitoring/metrics.service.js';
import { attachSourcePhotoToExternalCandidate } from '../../services/storage/photo-maintenance.service.js';
import { scheduleChunkInvalidation } from '../../services/embedding/embedding.service.js';
import { scheduleNewExternalCandidateAlert } from '../../services/notifications/new-match-alert.service.js';
import type {
  CreateExternalCandidateInput,
  UpdateExternalCandidateInput,
  ListExternalCandidatesQuery,
} from './external-candidate.validator.js';
import { findMatches } from '../../services/matching/matching.engine.js';
import type { MatchableInternal, MatchableExternal, MatchingContext } from '../../services/matching/matching.types.js';

export async function listExternalCandidates(
  query: ListExternalCandidatesQuery,
  currentUserId?: string,
): Promise<{ items: IExternalCandidate[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  const { skip, limit } = toSkipLimit(query);
  const sort = buildSort(query, 'createdAt');

  const filter: Record<string, unknown> = { archivedAt: { $exists: false } };
  if (query.status) filter['status'] = query.status;
  if (query.gender) filter['gender'] = query.gender;
  // `gender: null` matches both an explicit null and a missing field.
  if (query.missingGender) filter['gender'] = null;
  // Needs-details tab: unknown gender, not yet marked "מולא".
  if (query.needsDetails) {
    filter['gender'] = null;
    filter['detailsCompletedAt'] = { $exists: false };
  }
  if (query.sectorGroup) filter['sectorGroup'] = query.sectorGroup;
  if (query.city) filter['city'] = query.city;
  if (query.availabilityStatus) filter['availabilityStatus'] = query.availabilityStatus;
  if (query.search) filter['$text'] = { $search: query.search };
  applyOwnershipFilter(filter, 'ownerUserId', query.ownership, currentUserId);

  const [items, total] = await Promise.all([
    ExternalCandidate.find(filter).sort(sort).skip(skip).limit(limit).lean().exec(),
    ExternalCandidate.countDocuments(filter).exec(),
  ]);

  return {
    items: items as unknown as IExternalCandidate[],
    total,
    meta: makeMeta(query.page, query.limit, total),
  };
}

export async function getExternalCandidateById(id: string): Promise<IExternalCandidate> {
  const doc = await ExternalCandidate.findById(id).exec();
  if (!doc) throw new NotFoundError('ExternalCandidate', id);
  return doc;
}

// ── Photo (upload / remove / public share link) ──────────
// External photos usually arrive from the WhatsApp card, but an operator can
// also upload/replace one manually. Mirrors the internal candidate flow.

export async function setExternalCandidatePhoto(
  id: string,
  data: Buffer,
  ext: string,
): Promise<IExternalCandidate> {
  const doc = await getExternalCandidateById(id);
  if (!isStorageEnabled()) {
    throw new BusinessRuleError('אחסון התמונות (R2) לא מוגדר — לא ניתן להעלות תמונה');
  }
  const res = await syncCandidatePhoto({
    type: 'external',
    id: String(doc._id),
    lifecycleInput: { type: 'external', status: doc.status, archivedAt: doc.archivedAt ?? null },
    data,
    ext,
  });
  if (!res.ok || !res.storageKey) throw new BusinessRuleError('העלאת התמונה נכשלה');
  doc.photoUrl = res.proxyUrl;
  doc.photoStorageKey = res.storageKey;
  await doc.save();
  return doc;
}

export async function removeExternalCandidatePhoto(id: string): Promise<IExternalCandidate> {
  const doc = await getExternalCandidateById(id);
  if (doc.photoStorageKey) await deleteCandidatePhoto(doc.photoStorageKey);
  doc.photoUrl = undefined;
  doc.photoStorageKey = undefined;
  doc.photoShareToken = undefined;
  await doc.save();
  return doc;
}

export async function ensureExternalPhotoShareToken(id: string): Promise<string> {
  const doc = await getExternalCandidateById(id);
  if (!doc.photoStorageKey) throw new BusinessRuleError('אין תמונה למועמד — אין מה לשתף');
  if (!doc.photoShareToken) {
    doc.photoShareToken = generatePhotoShareToken();
    await doc.save();
  }
  return doc.photoShareToken;
}

// ── Source card ("כרטיס מקורי") ───────────────────────────
// Returns the original WhatsApp message(s) a candidate profile was
// extracted from — the raw "card" the AI received. Internal candidates
// are created manually (no source), so their variant returns hasSource:
// false and the UI shows a "no details" state. Shared shape so both
// candidate detail pages render the same tab.

export interface SourceCardMessageDTO {
  _id: string;
  contentType: string;
  body?: string;
  mediaUrl?: string;
  mediaCaption?: string;
  senderName?: string;
  senderPhone?: string;
  chatJid?: string;
  createdAt: string;
}

export interface SourceCardDTO {
  hasSource: boolean;
  sourceType?: string;
  sourceName?: string;
  sourceGroupName?: string;
  sourceSenderName?: string;
  sourceSenderPhone?: string;
  sourceImportedAt?: string;
  lastSourceUpdateAt?: string;
  messages: SourceCardMessageDTO[];
  // Fallback original text when the linked messages are gone but the raw
  // source payload preserved the card text.
  rawText?: string;
}

/** Best-effort pull of the original card text from a preserved raw payload. */
function rawPayloadText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  for (const key of ['text', 'body', 'rawText', 'message', 'content', 'caption']) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

export async function getExternalSourceCard(id: string): Promise<SourceCardDTO> {
  const doc = await ExternalCandidate.findById(id)
    .select(
      'sourceType sourceName sourceGroupName sourceSenderName sourceSenderPhone ' +
      'sourceImportedAt lastSourceUpdateAt sourceMessageIds rawSourcePayload',
    )
    .lean()
    .exec();
  if (!doc) throw new NotFoundError('ExternalCandidate', id);
  const d = doc as unknown as {
    sourceType?: string;
    sourceName?: string;
    sourceGroupName?: string;
    sourceSenderName?: string;
    sourceSenderPhone?: string;
    sourceImportedAt?: Date;
    lastSourceUpdateAt?: Date;
    sourceMessageIds?: Types.ObjectId[];
    rawSourcePayload?: unknown;
  };

  const ids = Array.isArray(d.sourceMessageIds) ? d.sourceMessageIds : [];
  let messages: SourceCardMessageDTO[] = [];
  if (ids.length) {
    const msgs = await Message.find({ _id: { $in: ids } })
      .select('contentType body mediaUrl mediaCaption senderName senderPhone chatJid createdAt')
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    messages = (msgs as unknown as Array<Record<string, unknown>>).map((m) => ({
      _id: String(m['_id']),
      contentType: String(m['contentType']),
      ...(m['body'] ? { body: String(m['body']) } : {}),
      ...(m['mediaUrl'] ? { mediaUrl: String(m['mediaUrl']) } : {}),
      ...(m['mediaCaption'] ? { mediaCaption: String(m['mediaCaption']) } : {}),
      ...(m['senderName'] ? { senderName: String(m['senderName']) } : {}),
      ...(m['senderPhone'] ? { senderPhone: String(m['senderPhone']) } : {}),
      ...(m['chatJid'] ? { chatJid: String(m['chatJid']) } : {}),
      createdAt: new Date(m['createdAt'] as Date).toISOString(),
    }));
  }

  const rawText = messages.length ? undefined : rawPayloadText(d.rawSourcePayload);
  const hasSource = messages.length > 0 || Boolean(rawText);

  return {
    hasSource,
    ...(d.sourceType ? { sourceType: d.sourceType } : {}),
    ...(d.sourceName ? { sourceName: d.sourceName } : {}),
    ...(d.sourceGroupName ? { sourceGroupName: d.sourceGroupName } : {}),
    ...(d.sourceSenderName ? { sourceSenderName: d.sourceSenderName } : {}),
    ...(d.sourceSenderPhone ? { sourceSenderPhone: d.sourceSenderPhone } : {}),
    ...(d.sourceImportedAt ? { sourceImportedAt: new Date(d.sourceImportedAt).toISOString() } : {}),
    ...(d.lastSourceUpdateAt ? { lastSourceUpdateAt: new Date(d.lastSourceUpdateAt).toISOString() } : {}),
    messages,
    ...(rawText ? { rawText } : {}),
  };
}

export async function createExternalCandidate(
  input: CreateExternalCandidateInput,
  performedBy: string,
): Promise<IExternalCandidate> {
  const normalizedPhone = normalizePhone(input.contactPhone);

  // Soft duplicate guard: refuse to create a second active external
  // with the same canonical phone. Callers can still reuse the
  // existing external by querying first; we do NOT silently merge.
  if (normalizedPhone) {
    const existing = await ExternalCandidate.findOne({
      contactPhoneNormalized: normalizedPhone,
      archivedAt: { $exists: false },
    }).select('_id firstName lastName').lean().exec();
    if (existing) {
      recordDuplicatePhone({ source: 'manual_create', existingCandidateId: String(existing._id) });
      throw new ConflictError(
        'An external candidate with this phone already exists',
        { code: 'duplicate_phone', existingCandidateId: String(existing._id) },
      );
    }
  }

  let doc: IExternalCandidate;
  try {
    doc = await ExternalCandidate.create({
      ...input,
      contactPhoneNormalized: normalizedPhone ?? undefined,
      // Seed the labeled multi-phone list (normalized + deduped server-side);
      // the primary contactPhone is folded in so it's never absent from it.
      phones: (input.phones?.length || input.contactPhone)
        ? mergePhoneEntries(undefined, [
            ...(input.phones ?? []),
            ...(input.contactPhone ? [{ number: input.contactPhone, source: 'card' }] : []),
          ])
        : undefined,
      sourceImportedAt: new Date(),
      importedBy: new Types.ObjectId(performedBy),
      ownerUserId: new Types.ObjectId(performedBy),
      shareCard: { approvedForShare: true },
    });
  } catch (err) {
    // Same-identity (name+age) active candidate already exists — refuse rather
    // than mint a duplicate, and name the existing card so the UI can offer to
    // open it instead.
    if (isDuplicateKeyError(err)) {
      const key = buildIdentityKey(input.firstName, input.lastName, input.age);
      const existing = key
        ? await ExternalCandidate.findOne({ identityKey: key, archivedAt: { $exists: false } }).select('_id').lean().exec()
        : null;
      throw new ConflictError(
        'An external candidate with the same name and age already exists',
        { code: 'duplicate_identity', existingCandidateId: existing ? String(existing._id) : undefined },
      );
    }
    throw err;
  }
  await audit({
    entityType: AuditEntityType.EXTERNAL_CANDIDATE,
    entityId: String(doc._id),
    actionType: AuditActionType.CREATE,
    performedBy,
    after: doc.toObject(),
  });

  // If this candidate was created from a WhatsApp source card (sourceMessageIds
  // present), pull its image into the R2 photo pipeline now — same immediate
  // behavior as the extraction paths. No-op for source-less manual entries.
  try {
    await attachSourcePhotoToExternalCandidate(doc);
  } catch {
    // Best-effort — the 30-min backfill sweep is the safety net.
  }

  // Semantic add-on: embed the new candidate (no-op when the toggle is off)
  // and, if the manager-alert feature is armed, WhatsApp a match card.
  scheduleNewExternalCandidateAlert(String(doc._id));

  return doc;
}

export async function updateExternalCandidate(
  id: string,
  input: UpdateExternalCandidateInput,
  performedBy: string,
  actor?: AuthUser,
): Promise<IExternalCandidate> {
  const doc = await getExternalCandidateById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'external candidate' });
  if (doc.archivedAt) throw new BusinessRuleError('External candidate is archived');

  const before = doc.toObject();
  // Snapshot the pre-edit primary phone: if the edit REPLACES it with a
  // different number, the old one is preserved in the phones list rather
  // than silently lost (multi-phone policy: never drop a known number).
  const prevContactPhone = doc.contactPhone;
  Object.assign(doc, input);
  // Keep contactPhoneNormalized in sync with contactPhone edits.
  if (input.contactPhone !== undefined) {
    doc.contactPhoneNormalized = normalizePhone(input.contactPhone) ?? undefined;
  }
  // An explicit phones list from the UI is authoritative (relabel/remove),
  // but is re-normalized and deduped server-side.
  if (input.phones !== undefined) {
    doc.phones = input.phones.length ? mergePhoneEntries(undefined, input.phones) : undefined;
  }
  if (input.contactPhone && input.phones === undefined) {
    doc.phones = mergePhoneEntries(doc.phones, [
      ...(prevContactPhone ? [{ number: prevContactPhone, source: 'card' }] : []),
      { number: input.contactPhone, source: 'card' },
    ]);
  }
  doc.lastSourceUpdateAt = new Date();
  try {
    await doc.save();
  } catch (err) {
    // Edit would make this card a name+age twin of an existing active one.
    if (isDuplicateKeyError(err)) {
      const existing = doc.identityKey
        ? await ExternalCandidate.findOne({
            identityKey: doc.identityKey,
            archivedAt: { $exists: false },
            _id: { $ne: doc._id },
          }).select('_id').lean().exec()
        : null;
      throw new ConflictError(
        'This edit would duplicate an existing candidate with the same name and age',
        { code: 'duplicate_identity', existingCandidateId: existing ? String(existing._id) : undefined },
      );
    }
    throw err;
  }

  await audit({
    entityType: AuditEntityType.EXTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: doc.toObject(),
  });

  // Re-embed only the chunks the edited fields feed (no-op when the
  // admin toggle is off).
  scheduleChunkInvalidation(id, 'external', Object.keys(input));

  return doc;
}

export async function archiveExternalCandidate(id: string, performedBy: string, actor?: AuthUser): Promise<void> {
  const doc = await getExternalCandidateById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'external candidate' });
  if (doc.archivedAt) return;
  const before = doc.toObject();
  doc.archivedAt = new Date();
  doc.status = ExternalCandidateStatus.ARCHIVED;
  await doc.save();
  await audit({
    entityType: AuditEntityType.EXTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.ARCHIVE,
    performedBy,
    before,
    after: doc.toObject(),
  });
}

export async function updateShareCard(
  id: string,
  patch: Record<string, unknown>,
  performedBy: string,
  actor?: AuthUser,
): Promise<IExternalCandidate> {
  const doc = await getExternalCandidateById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'external candidate' });
  const before = doc.toObject();
  doc.shareCard = {
    ...(doc.shareCard ?? { approvedForShare: false }),
    ...patch,
    lastReviewedAt: new Date(),
  } as IExternalCandidate['shareCard'];
  await doc.save();
  await audit({
    entityType: AuditEntityType.EXTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { scope: 'shareCard' },
  });
  return doc;
}

export async function updateAvailability(
  id: string,
  availabilityStatus: string,
  staleReason: string | undefined,
  confirmAvailable: boolean | undefined,
  performedBy: string,
  actor?: AuthUser,
): Promise<IExternalCandidate> {
  const doc = await getExternalCandidateById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'external candidate' });
  const before = doc.toObject();

  doc.availabilityStatus = availabilityStatus as IExternalCandidate['availabilityStatus'];
  if (confirmAvailable) doc.lastConfirmedAvailableAt = new Date();
  if (availabilityStatus === 'unavailable' || availabilityStatus === 'dating') {
    doc.staleAt = new Date();
    doc.staleReason = staleReason;
  } else if (availabilityStatus === 'available') {
    doc.staleAt = undefined;
    doc.staleReason = undefined;
  }
  doc.lastSourceUpdateAt = new Date();
  await doc.save();

  await audit({
    entityType: AuditEntityType.EXTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { scope: 'availability' },
  });

  return doc;
}

// ── Needs-details workflow ───────────────────────────────
// The "נדרש למלא פרטים" tab lists gender-unknown candidates. When the
// operator finished filling whatever is knowable, they mark the profile
// "מולא" — it leaves the tab even if some fields stay empty.

export async function setDetailsCompleted(
  id: string,
  completed: boolean,
  performedBy: string,
  actor?: AuthUser,
): Promise<IExternalCandidate> {
  const doc = await getExternalCandidateById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'external candidate' });
  const before = doc.toObject();

  doc.detailsCompletedAt = completed ? new Date() : undefined;
  await doc.save();

  await audit({
    entityType: AuditEntityType.EXTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { scope: 'details-completed', completed },
  });

  return doc;
}

// ── Reverse-direction matching ───────────────────────────
// Given an external candidate, run the engine against all eligible
// internal candidates. Delegates to the deterministic engine — NOT
// to AI, and NOT to any hand-rolled scoring.

export async function findMatchingInternals(
  externalId: string,
  mode: 'strict' | 'discovery',
  limit: number,
): Promise<unknown[]> {
  const external = await getExternalCandidateById(externalId);

  const internals = await InternalCandidate.find({
    status: 'active',
    archivedAt: { $exists: false },
    gender: external.gender === 'male' ? 'female' : 'male',
  })
    .limit(500)
    .lean()
    .exec();

  // Batch the per-internal context lookups into two queries (avoids N+1).
  const internalIds = internals.map((i) => i._id);

  const activeSuggestions = await MatchSuggestion.find({
    internalCandidateId: { $in: internalIds },
    status: { $nin: ['closed', 'expired'] },
  }).select('internalCandidateId externalCandidateId').lean().exec();

  const declineSuggestions = await MatchSuggestion.find({
    internalCandidateId: { $in: internalIds },
    status: { $in: ['declined_side_a', 'declined_side_b'] },
  }).select('internalCandidateId externalCandidateId closedAt').lean().exec();

  // Pairs (THIS external + an internal) whose suggestion the operator already
  // ended (closed/expired). The suggestion no longer exists, so the pair must
  // not resurface as a live match — skip those internals below.
  const endedPairs = await MatchSuggestion.find({
    externalCandidateId: externalId,
    status: { $in: ['closed', 'expired'] },
  }).select('internalCandidateId').lean().exec();
  const endedInternalIds = new Set(endedPairs.map((s) => String(s.internalCandidateId)));

  // Group results per internal candidate, keyed by String(internalCandidateId).
  const activeByInternal = new Map<string, typeof activeSuggestions>();
  for (const s of activeSuggestions) {
    const key = String(s.internalCandidateId);
    const list = activeByInternal.get(key);
    if (list) list.push(s);
    else activeByInternal.set(key, [s]);
  }
  const declinesByInternal = new Map<string, typeof declineSuggestions>();
  for (const d of declineSuggestions) {
    const key = String(d.internalCandidateId);
    const list = declinesByInternal.get(key);
    if (list) list.push(d);
    else declinesByInternal.set(key, [d]);
  }

  const results: unknown[] = [];

  for (const internal of internals) {
    // Context for this internal (active matches + recent declines)
    const internalKey = String(internal._id);
    // Pair already closed/expired with this external → not a live match anymore.
    if (endedInternalIds.has(internalKey)) continue;
    const active = activeByInternal.get(internalKey) ?? [];

    const activeMatchExternalIds = new Set<string>(active.map((s) => String(s.externalCandidateId)));
    const declines = declinesByInternal.get(internalKey) ?? [];
    const recentDeclines = new Map<string, Date>();
    for (const d of declines) {
      if (d.closedAt) recentDeclines.set(String(d.externalCandidateId), d.closedAt);
    }

    const ctx: MatchingContext = {
      mode,
      activeMatchExternalIds,
      recentDeclines,
      activeSuggestionCount: active.length,
    };

    const [r] = findMatches(
      toMatchableInternal(internal),
      [toMatchableExternal(external.toObject())],
      ctx,
    );
    if (r) results.push({ ...r, internalCandidate: { id: String(internal._id), firstName: internal.firstName, lastName: internal.lastName } });
  }

  results.sort((a, b) => ((b as { matchScore: number }).matchScore ?? 0) - ((a as { matchScore: number }).matchScore ?? 0));
  return results.slice(0, limit);
}

// ── Conversions ─────────────────────────────────────────

function toMatchableInternal(doc: Record<string, unknown>): MatchableInternal {
  return {
    _id: String(doc['_id']),
    firstName: (doc['firstName'] as string) ?? '',
    lastName: (doc['lastName'] as string) ?? '',
    gender: doc['gender'] as MatchableInternal['gender'],
    dateOfBirth: doc['dateOfBirth'] as Date,
    city: doc['city'] as string | undefined,
    height: doc['height'] as number | undefined,
    sectorGroup: doc['sectorGroup'] as MatchableInternal['sectorGroup'],
    subSector: doc['subSector'] as MatchableInternal['subSector'],
    lifestyleTone: doc['lifestyleTone'] as MatchableInternal['lifestyleTone'],
    religiousStyle: doc['religiousStyle'] as MatchableInternal['religiousStyle'],
    personalStatus: (doc['personalStatus'] as MatchableInternal['personalStatus']) ?? 'single',
    numberOfChildren: (doc['numberOfChildren'] as number) ?? 0,
    lifeStage: doc['lifeStage'] as MatchableInternal['lifeStage'],
    readinessForMarriage: (doc['readinessForMarriage'] as MatchableInternal['readinessForMarriage']) ?? 'open',
    studyWorkDirection: doc['studyWorkDirection'] as MatchableInternal['studyWorkDirection'],
    hardConstraints: (doc['hardConstraints'] as MatchableInternal['hardConstraints']) ?? [],
    softPreferences: (doc['softPreferences'] as MatchableInternal['softPreferences']) ?? [],
    agePreferences: doc['agePreferences'] as MatchableInternal['agePreferences'],
    locationPreferences: doc['locationPreferences'] as MatchableInternal['locationPreferences'],
    // openToDivorced omitted (tri-state): missing openness = unknown, not "not open".
    openness: (doc['openness'] as MatchableInternal['openness']) ?? {
      openToOtherSectors: false,
      openToConverts: false,
      openToWithChildren: false,
      openToAgeDifference: false,
      openToLongDistance: false,
    },
    profileCompletion: (doc['profileCompletion'] as number) ?? 0,
    missingCriticalFields: (doc['missingCriticalFields'] as string[]) ?? [],
    sendReadinessBlockers: (doc['sendReadinessBlockers'] as string[]) ?? [],
    profileQualityScore: doc['profileQualityScore'] as number | undefined,
    dataReliabilityScore: doc['dataReliabilityScore'] as number | undefined,
    readinessScore: doc['readinessScore'] as number | undefined,
    status: (doc['status'] as MatchableInternal['status']) ?? 'active',
    lastVerifiedAt: doc['lastVerifiedAt'] as Date | undefined,
    lastActionAt: doc['lastActionAt'] as Date | undefined,
    datingPartnerCandidateId: doc['datingPartnerCandidateId']
      ? String(doc['datingPartnerCandidateId'])
      : undefined,
    deferredSuggestionsCount: (doc['deferredSuggestionsCount'] as number) ?? 0,
  };
}

// ── Learnings ("מה למדנו") ────────────────────────────────
//
// Unlike internal candidates (which get an AI-summarised CandidateInsight),
// there is no per-external learning agent. Instead we surface what was actually
// recorded about this external across their closed suggestions: the per-side
// "why not" reasons and the operator's closing note. Deterministic — no AI, no
// score. Empty list ⇒ the tab shows "nothing learned yet".

export interface ExternalLearningItem {
  matchSuggestionId: string;
  partnerId: string;
  partnerName: string;
  status: string;
  closedAt?: string;
  aboutExternal?: string; // sideBResponse.declineReason — about THIS candidate
  aboutPartner?: string;  // sideAResponse.declineReason — about the internal side
  note?: string;          // closeReason — the operator's general closing note
}

export interface ManualLearningItem {
  id: string;
  text: string;
  createdAt: string;
  createdBy?: string;
}

export async function getExternalCandidateLearnings(id: string): Promise<{
  externalCandidateId: string;
  total: number;
  items: ExternalLearningItem[];
  manual: ManualLearningItem[];
}> {
  const candidate = await getExternalCandidateById(id); // 404 if the candidate doesn't exist

  const matches = await MatchSuggestion.find({
    externalCandidateId: new Types.ObjectId(id),
    // Only suggestions that actually carry a learned reason — a plain
    // status change with no "why" teaches us nothing.
    $or: [
      { 'sideAResponse.declineReason': { $nin: [null, ''] } },
      { 'sideBResponse.declineReason': { $nin: [null, ''] } },
      { closeReason: { $nin: [null, ''] } },
    ],
  })
    .select('internalCandidateId status closedAt closeReason sideAResponse.declineReason sideBResponse.declineReason updatedAt')
    .sort({ closedAt: -1, updatedAt: -1 })
    .lean()
    .exec();

  const internalIds = [...new Set(matches.map((m) => String(m.internalCandidateId)))];
  const internals = await InternalCandidate.find({ _id: { $in: internalIds } })
    .select('firstName lastName').lean().exec();
  const nameOf = (c: { firstName?: string; lastName?: string }) =>
    `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'ללא שם';
  const nameMap = new Map(internals.map((c) => [String(c._id), nameOf(c)]));

  const items: ExternalLearningItem[] = matches.map((m) => ({
    matchSuggestionId: String(m._id),
    partnerId: String(m.internalCandidateId),
    partnerName: nameMap.get(String(m.internalCandidateId)) ?? 'ללא שם',
    status: m.status,
    ...(m.closedAt ? { closedAt: new Date(m.closedAt).toISOString() } : {}),
    ...(m.sideBResponse?.declineReason ? { aboutExternal: m.sideBResponse.declineReason } : {}),
    ...(m.sideAResponse?.declineReason ? { aboutPartner: m.sideAResponse.declineReason } : {}),
    ...(m.closeReason ? { note: m.closeReason } : {}),
  }));

  const manual: ManualLearningItem[] = (candidate.manualLearnings ?? [])
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((l) => ({
      id: String(l._id),
      text: l.text,
      createdAt: new Date(l.createdAt).toISOString(),
      ...(l.createdBy ? { createdBy: String(l.createdBy) } : {}),
    }));

  return { externalCandidateId: id, total: items.length, items, manual };
}

// Add a hand-written learning to an external candidate. These live alongside
// the auto-collected close reasons in the "מה למדנו" tab.
export async function addExternalLearning(
  id: string,
  text: string,
  performedBy: string,
  actor?: AuthUser,
): Promise<IExternalCandidate> {
  const doc = await getExternalCandidateById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'external candidate' });
  const clean = text.trim();
  if (!clean) throw new BusinessRuleError('Learning text is required');
  const before = doc.toObject();

  const entry = { text: clean, createdBy: new Types.ObjectId(performedBy), createdAt: new Date() };
  doc.manualLearnings = [...(doc.manualLearnings ?? []), entry] as unknown as IExternalCandidate['manualLearnings'];
  await doc.save();

  await audit({
    entityType: AuditEntityType.EXTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { scope: 'manual-learning', op: 'add' },
  });

  return doc;
}

export async function removeExternalLearning(
  id: string,
  learningId: string,
  performedBy: string,
  actor?: AuthUser,
): Promise<IExternalCandidate> {
  const doc = await getExternalCandidateById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'external candidate' });
  const before = doc.toObject();

  const arr = doc.manualLearnings ?? [];
  if (!arr.some((l) => String(l._id) === learningId)) {
    throw new NotFoundError('ManualLearning', learningId);
  }
  doc.manualLearnings = arr.filter((l) => String(l._id) !== learningId) as unknown as IExternalCandidate['manualLearnings'];
  await doc.save();

  await audit({
    entityType: AuditEntityType.EXTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { scope: 'manual-learning', op: 'remove', learningId },
  });

  return doc;
}

function toMatchableExternal(doc: Record<string, unknown>): MatchableExternal {
  return {
    _id: String(doc['_id']),
    firstName: doc['firstName'] as string | undefined,
    lastName: doc['lastName'] as string | undefined,
    gender: doc['gender'] as MatchableExternal['gender'],
    age: doc['age'] as number | undefined,
    city: doc['city'] as string | undefined,
    height: doc['height'] as number | undefined,
    sectorGroup: doc['sectorGroup'] as MatchableExternal['sectorGroup'],
    subSector: doc['subSector'] as MatchableExternal['subSector'],
    lifestyleTone: doc['lifestyleTone'] as MatchableExternal['lifestyleTone'],
    personalStatus: doc['personalStatus'] as MatchableExternal['personalStatus'],
    lifeStage: doc['lifeStage'] as MatchableExternal['lifeStage'],
    studyWorkDirection: doc['studyWorkDirection'] as MatchableExternal['studyWorkDirection'],
    availabilityStatus: (doc['availabilityStatus'] as MatchableExternal['availabilityStatus']) ?? 'unknown',
    status: (doc['status'] as MatchableExternal['status']) ?? 'active',
    shareCard: (doc['shareCard'] as MatchableExternal['shareCard']) ?? { approvedForShare: false },
    ageReliability: doc['ageReliability'] as MatchableExternal['ageReliability'],
    hardConstraints: doc['hardConstraints'] as MatchableExternal['hardConstraints'],
    softPreferences: doc['softPreferences'] as MatchableExternal['softPreferences'],
    agePreferences: doc['agePreferences'] as MatchableExternal['agePreferences'],
    locationPreferences: doc['locationPreferences'] as MatchableExternal['locationPreferences'],
    openness: doc['openness'] as MatchableExternal['openness'],
    staleAt: doc['staleAt'] as Date | undefined,
    lastConfirmedAvailableAt: doc['lastConfirmedAvailableAt'] as Date | undefined,
    lastSourceUpdateAt: doc['lastSourceUpdateAt'] as Date | undefined,
    sourceImportedAt: (doc['sourceImportedAt'] as Date) ?? new Date(0),
  };
}
