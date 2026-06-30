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
  type IExternalCandidate,
} from '../../models/index.js';
import { audit } from '../../services/audit.service.js';
import { NotFoundError, BusinessRuleError, ConflictError } from '../../utils/errors.js';
import { toSkipLimit, buildSort, makeMeta } from '../../utils/pagination.js';
import { applyOwnershipFilter } from '../../utils/ownership.js';
import { assertOwnership } from '../../utils/ownership.assert.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';
import { normalizePhone } from '../../utils/phone.js';
import { recordDuplicatePhone } from '../../services/monitoring/metrics.service.js';
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

  const doc = await ExternalCandidate.create({
    ...input,
    contactPhoneNormalized: normalizedPhone ?? undefined,
    sourceImportedAt: new Date(),
    importedBy: new Types.ObjectId(performedBy),
    ownerUserId: new Types.ObjectId(performedBy),
    shareCard: { approvedForShare: false },
  });
  await audit({
    entityType: AuditEntityType.EXTERNAL_CANDIDATE,
    entityId: String(doc._id),
    actionType: AuditActionType.CREATE,
    performedBy,
    after: doc.toObject(),
  });
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
  Object.assign(doc, input);
  // Keep contactPhoneNormalized in sync with contactPhone edits.
  if (input.contactPhone !== undefined) {
    doc.contactPhoneNormalized = normalizePhone(input.contactPhone) ?? undefined;
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
  });

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
    openness: (doc['openness'] as MatchableInternal['openness']) ?? {
      openToOtherSectors: false,
      openToConverts: false,
      openToDivorced: false,
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
