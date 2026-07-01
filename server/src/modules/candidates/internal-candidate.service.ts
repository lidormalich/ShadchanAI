// ═══════════════════════════════════════════════════════════
// ShadchanAI — Internal Candidate Service
//
// Business logic for internal candidates. Enforces:
//   - Closure rules (can't update or match a closed candidate)
//   - Dating lock (can't create new matches while dating; can
//     only exit dating through the reopen flow)
//   - Send-readiness computation (profileCompletion +
//     missingCriticalFields + sendReadinessBlockers)
//   - Audit logging on every mutation
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import {
  AuditActionType,
  AuditEntityType,
  CandidateStatus,
  MatchSuggestionStatus,
} from '@shadchanai/shared';
import { InternalCandidate, MatchSuggestion, Conversation, type IInternalCandidate } from '../../models/index.js';
import { audit } from '../../services/audit.service.js';
import { BusinessRuleError, NotFoundError } from '../../utils/errors.js';
import { toSkipLimit, buildSort, makeMeta, type PaginationQuery } from '../../utils/pagination.js';
import { applyOwnershipFilter } from '../../utils/ownership.js';
import { assertOwnership } from '../../utils/ownership.assert.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';
import type {
  CreateInternalCandidateInput,
  UpdateInternalCandidateInput,
  ListInternalCandidatesQuery,
} from './internal-candidate.validator.js';

// ── Readiness computation ────────────────────────────────
// Lives here so it stays in sync with business definition.

const CRITICAL_FIELDS = [
  'firstName',
  'lastName',
  'gender',
  'dateOfBirth',
  'sectorGroup',
  'readinessForMarriage',
] as const;

const RECOMMENDED_FIELDS = [
  'city',
  'subSector',
  'lifestyleTone',
  'lifeStage',
  'studyWorkDirection',
  'about',
  'whatSeeking',
  'photoUrl',
  'phone',
] as const;

export interface ReadinessDetails {
  profileCompletion: number;
  missingCriticalFields: string[];
  sendReadinessBlockers: string[];
}

export function computeReadiness(doc: Partial<IInternalCandidate>): ReadinessDetails {
  const missingCriticalFields: string[] = [];
  for (const f of CRITICAL_FIELDS) {
    if (!hasValue((doc as Record<string, unknown>)[f])) missingCriticalFields.push(f);
  }

  let present = 0;
  const totalFields = CRITICAL_FIELDS.length + RECOMMENDED_FIELDS.length;
  for (const f of [...CRITICAL_FIELDS, ...RECOMMENDED_FIELDS]) {
    if (hasValue((doc as Record<string, unknown>)[f])) present += 1;
  }
  const profileCompletion = Math.round((present / totalFields) * 100);

  const sendReadinessBlockers: string[] = [];
  if (missingCriticalFields.length > 0) {
    sendReadinessBlockers.push(`Missing critical fields: ${missingCriticalFields.join(', ')}`);
  }
  if (doc.photoUrl && !doc.photoApproved) {
    sendReadinessBlockers.push('Photo not yet approved');
  }
  if (profileCompletion < 60) {
    sendReadinessBlockers.push(`Profile completion below 60% (${profileCompletion}%)`);
  }
  if (!doc.referenceName && !doc.referencePhone) {
    sendReadinessBlockers.push('No reference provided');
  }

  return { profileCompletion, missingCriticalFields, sendReadinessBlockers };
}

function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  return true;
}

// ── CRUD ──────────────────────────────────────────────────

export async function listInternalCandidates(
  query: ListInternalCandidatesQuery,
  currentUserId?: string,
): Promise<{ items: IInternalCandidate[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  const { skip, limit } = toSkipLimit(query);
  const sort = buildSort(query, 'createdAt');

  const filter: Record<string, unknown> = { archivedAt: { $exists: false } };
  if (query.status) filter['status'] = query.status;
  if (query.gender) filter['gender'] = query.gender;
  // `gender: null` matches both an explicit null and a missing field.
  if (query.missingGender) filter['gender'] = null;
  if (query.sectorGroup) filter['sectorGroup'] = query.sectorGroup;
  if (query.city) filter['city'] = query.city;
  if (query.search) {
    filter['$text'] = { $search: query.search };
  }
  applyOwnershipFilter(filter, 'ownerUserId', query.ownership, currentUserId);

  const [items, total] = await Promise.all([
    InternalCandidate.find(filter).sort(sort).skip(skip).limit(limit).lean().exec(),
    InternalCandidate.countDocuments(filter).exec(),
  ]);

  return {
    items: items as unknown as IInternalCandidate[],
    total,
    meta: makeMeta(query.page, query.limit, total),
  };
}

export async function getInternalCandidateById(id: string): Promise<IInternalCandidate> {
  const doc = await InternalCandidate.findById(id).exec();
  if (!doc) throw new NotFoundError('InternalCandidate', id);
  return doc;
}

export async function createInternalCandidate(
  input: CreateInternalCandidateInput,
  performedBy: string,
): Promise<IInternalCandidate> {
  const readiness = computeReadiness(input as Partial<IInternalCandidate>);

  const doc = await InternalCandidate.create({
    ...input,
    status: CandidateStatus.ACTIVE,
    createdBy: new Types.ObjectId(performedBy),
    ownerUserId: new Types.ObjectId(performedBy),
    profileCompletion: readiness.profileCompletion,
    missingCriticalFields: readiness.missingCriticalFields,
    sendReadinessBlockers: readiness.sendReadinessBlockers,
  });

  await audit({
    entityType: AuditEntityType.INTERNAL_CANDIDATE,
    entityId: String(doc._id),
    actionType: AuditActionType.CREATE,
    performedBy,
    after: doc.toObject(),
  });

  return doc;
}

export async function updateInternalCandidate(
  id: string,
  input: UpdateInternalCandidateInput,
  performedBy: string,
  actor?: AuthUser,
): Promise<IInternalCandidate> {
  const existing = await getInternalCandidateById(id);
  if (actor) assertOwnership(existing.ownerUserId, actor, { entity: 'internal candidate' });
  assertNotClosed(existing);

  const before = existing.toObject();
  Object.assign(existing, input);

  const readiness = computeReadiness(existing.toObject());
  existing.profileCompletion = readiness.profileCompletion;
  existing.missingCriticalFields = readiness.missingCriticalFields;
  existing.sendReadinessBlockers = readiness.sendReadinessBlockers;
  existing.lastActionAt = new Date();

  await existing.save();

  await audit({
    entityType: AuditEntityType.INTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: existing.toObject(),
  });

  return existing;
}

// ── Lifecycle operations ─────────────────────────────────

export async function archiveInternalCandidate(id: string, performedBy: string, actor?: AuthUser): Promise<void> {
  const doc = await getInternalCandidateById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'internal candidate' });
  if (doc.archivedAt) return;

  const before = doc.toObject();
  doc.archivedAt = new Date();
  doc.status = CandidateStatus.ARCHIVED;
  await doc.save();

  await audit({
    entityType: AuditEntityType.INTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.ARCHIVE,
    performedBy,
    before,
    after: doc.toObject(),
  });
}

export async function closeInternalCandidate(
  id: string,
  reason: string,
  note: string | undefined,
  performedBy: string,
  actor?: AuthUser,
): Promise<IInternalCandidate> {
  const doc = await getInternalCandidateById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'internal candidate' });
  const before = doc.toObject();

  doc.status = CandidateStatus.CLOSED;
  doc.closureReason = reason as IInternalCandidate['closureReason'];
  doc.closureNote = note;
  doc.closedAt = new Date();
  doc.closedBy = new Types.ObjectId(performedBy);
  await doc.save();

  await audit({
    entityType: AuditEntityType.INTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { transition: 'close', reason, note },
  });

  return doc;
}

export async function markInternalCandidateDating(
  id: string,
  partnerCandidateId: string,
  sourceMatchId: string | undefined,
  performedBy: string,
  actor?: AuthUser,
): Promise<IInternalCandidate> {
  const doc = await getInternalCandidateById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'internal candidate' });
  if (doc.status === CandidateStatus.CLOSED || doc.status === CandidateStatus.ARCHIVED) {
    throw new BusinessRuleError('Cannot mark a closed/archived candidate as dating');
  }
  if (doc.datingPartnerCandidateId && String(doc.datingPartnerCandidateId) !== partnerCandidateId) {
    throw new BusinessRuleError('Candidate is already dating a different partner');
  }

  const before = doc.toObject();
  doc.status = CandidateStatus.DATING;
  doc.datingPartnerCandidateId = new Types.ObjectId(partnerCandidateId);
  doc.datingStartedAt = new Date();
  doc.datingSourceMatchId = sourceMatchId ? new Types.ObjectId(sourceMatchId) : undefined;
  await doc.save();

  await audit({
    entityType: AuditEntityType.INTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { transition: 'mark_dating', partnerCandidateId, sourceMatchId },
  });

  return doc;
}

export async function reopenInternalCandidate(
  id: string,
  fromDatingMatchId: string | undefined,
  reason: string,
  note: string | undefined,
  performedBy: string,
  actor?: AuthUser,
): Promise<IInternalCandidate> {
  const doc = await getInternalCandidateById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'internal candidate' });
  if (doc.status !== CandidateStatus.DATING && doc.status !== CandidateStatus.CLOSED && doc.status !== CandidateStatus.PAUSED) {
    throw new BusinessRuleError('Only dating/closed/paused candidates can be reopened');
  }

  const before = doc.toObject();
  doc.status = CandidateStatus.ACTIVE;
  doc.datingPartnerCandidateId = undefined;
  doc.datingStartedAt = undefined;
  doc.datingSourceMatchId = undefined;
  doc.closureReason = undefined;
  doc.closureNote = undefined;
  doc.closedAt = undefined;
  doc.closedBy = undefined;
  doc.lastActionAt = new Date();
  await doc.save();

  // If reopened from a dating match, mark that match deferred (not closed)
  if (fromDatingMatchId && Types.ObjectId.isValid(fromDatingMatchId)) {
    await MatchSuggestion.updateOne(
      { _id: new Types.ObjectId(fromDatingMatchId) },
      {
        $set: {
          status: MatchSuggestionStatus.DEFERRED,
          isDeferred: true,
          deferredAt: new Date(),
          deferredReason: reason,
          reopenedFromDeferredAt: undefined,
        },
      },
    ).exec();
  }

  await audit({
    entityType: AuditEntityType.INTERNAL_CANDIDATE,
    entityId: id,
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { transition: 'reopen', reason, note, fromDatingMatchId },
  });

  return doc;
}

// ── Queries for candidate detail views ───────────────────

export async function getCandidateSuggestions(
  id: string,
  query: PaginationQuery,
): Promise<{ items: unknown[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  const { skip, limit } = toSkipLimit(query);
  const filter = { internalCandidateId: new Types.ObjectId(id) };
  const [items, total] = await Promise.all([
    MatchSuggestion.find(filter).sort({ matchScore: -1 }).skip(skip).limit(limit).lean().exec(),
    MatchSuggestion.countDocuments(filter).exec(),
  ]);
  return { items, total, meta: makeMeta(query.page, query.limit, total) };
}

export async function getCandidateConversations(id: string): Promise<unknown[]> {
  return Conversation.find({ internalCandidateId: new Types.ObjectId(id) })
    .sort({ lastMessageAt: -1 })
    .limit(100)
    .lean()
    .exec();
}

export async function getCandidateReadiness(id: string): Promise<ReadinessDetails> {
  const doc = await getInternalCandidateById(id);
  return computeReadiness(doc.toObject());
}

// ── Invariants ───────────────────────────────────────────

function assertNotClosed(doc: IInternalCandidate): void {
  if (doc.status === CandidateStatus.CLOSED) {
    throw new BusinessRuleError('Candidate is closed — reopen before editing');
  }
  if (doc.archivedAt) {
    throw new BusinessRuleError('Candidate is archived — cannot edit');
  }
}
