// ═══════════════════════════════════════════════════════════
// PairReview service — operator memory for compatibility decisions.
//
// All writes:
//   - upsert by (internalCandidateId, externalCandidateId)
//   - append the prior decision to history[] before overwriting
//   - audit every write
//
// Reads are scoped per internal candidate (board view) or per
// pair (detail view).
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { AuditActionType, AuditEntityType } from '@shadchanai/shared';
import {
  PairReview,
  InternalCandidate,
  ExternalCandidate,
  MatchSuggestion,
  type IPairReview,
  type PairReviewStatus,
} from '../../models/index.js';
import { audit } from '../../services/audit.service.js';
import { NotFoundError } from '../../utils/errors.js';
import { assertOwnership } from '../../utils/ownership.assert.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';
import { explainMatch } from '../../services/ai/ai.service.js';
import { ingestReasons } from '../rejection-reasons/rejection-reason.service.js';
// Static import (no runtime import()): match.service is split, so
// pulling the specific evaluatePair function no longer forms a cycle.
import { evaluatePair } from '../matches/match.scoring.js';

export interface UpsertPairReviewInput {
  internalCandidateId: string;
  externalCandidateId: string;
  manualStatus: PairReviewStatus;
  operatorReason?: string;
  outcomeReason?: string;
  matchSuggestionId?: string;
  performedBy: string;
}

export async function listForInternal(
  internalId: string,
): Promise<IPairReview[]> {
  return PairReview.find({
    internalCandidateId: new Types.ObjectId(internalId),
  })
    .sort({ reviewedAt: -1 })
    .lean()
    .exec() as unknown as IPairReview[];
}

export async function getForPair(
  internalId: string,
  externalId: string,
): Promise<IPairReview | null> {
  return PairReview.findOne({
    internalCandidateId: new Types.ObjectId(internalId),
    externalCandidateId: new Types.ObjectId(externalId),
  })
    .lean()
    .exec() as unknown as IPairReview | null;
}

export async function upsertReview(
  input: UpsertPairReviewInput,
): Promise<IPairReview> {
  const {
    internalCandidateId,
    externalCandidateId,
    manualStatus,
    operatorReason,
    outcomeReason,
    matchSuggestionId,
    performedBy,
  } = input;

  const internalOid = new Types.ObjectId(internalCandidateId);
  const externalOid = new Types.ObjectId(externalCandidateId);
  const performerOid = new Types.ObjectId(performedBy);
  const now = new Date();

  const existing = await PairReview.findOne({
    internalCandidateId: internalOid,
    externalCandidateId: externalOid,
  }).exec();

  const before = existing ? existing.toObject() : undefined;

  let doc: IPairReview;
  if (!existing) {
    doc = await PairReview.create({
      internalCandidateId: internalOid,
      externalCandidateId: externalOid,
      manualStatus,
      operatorReason,
      outcomeReason,
      matchSuggestionId: matchSuggestionId ? new Types.ObjectId(matchSuggestionId) : undefined,
      reviewedBy: performerOid,
      reviewedAt: now,
      history: [],
    });
  } else {
    // Snapshot the prior decision into history[] before overwriting.
    existing.history.push({
      status: existing.manualStatus,
      reason: existing.operatorReason ?? existing.outcomeReason,
      reviewedBy: existing.reviewedBy,
      reviewedAt: existing.reviewedAt,
    });
    existing.manualStatus = manualStatus;
    existing.operatorReason = operatorReason;
    existing.outcomeReason = outcomeReason;
    if (matchSuggestionId) {
      existing.matchSuggestionId = new Types.ObjectId(matchSuggestionId);
    }
    existing.reviewedBy = performerOid;
    existing.reviewedAt = now;
    await existing.save();
    doc = existing;
  }

  await audit({
    entityType: AuditEntityType.PAIR_REVIEW,
    entityId: String(doc._id),
    actionType: AuditActionType.PAIR_REVIEW_SET,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: {
      internalCandidateId,
      externalCandidateId,
      manualStatus,
      previousStatus: before ? (before as { manualStatus?: string }).manualStatus : undefined,
    },
  });

  // Mirror onto the InternalCandidate timeline so the operator sees
  // the decision in the candidate's "history" tab.
  await audit({
    entityType: AuditEntityType.INTERNAL_CANDIDATE,
    entityId: internalCandidateId,
    actionType: AuditActionType.PAIR_REVIEW_SET,
    performedBy,
    metadata: {
      externalCandidateId,
      manualStatus,
      operatorReason,
      outcomeReason,
    },
  });

  return doc;
}

export async function clearReview(
  internalCandidateId: string,
  externalCandidateId: string,
  performedBy: string,
): Promise<void> {
  const doc = await PairReview.findOne({
    internalCandidateId: new Types.ObjectId(internalCandidateId),
    externalCandidateId: new Types.ObjectId(externalCandidateId),
  }).exec();
  if (!doc) throw new NotFoundError('PairReview', `${internalCandidateId}:${externalCandidateId}`);

  const before = doc.toObject();
  await doc.deleteOne();

  await audit({
    entityType: AuditEntityType.PAIR_REVIEW,
    entityId: String(doc._id),
    actionType: AuditActionType.PAIR_REVIEW_CLEARED,
    performedBy,
    before,
    metadata: { internalCandidateId, externalCandidateId },
  });

  await audit({
    entityType: AuditEntityType.INTERNAL_CANDIDATE,
    entityId: internalCandidateId,
    actionType: AuditActionType.PAIR_REVIEW_CLEARED,
    performedBy,
    metadata: { externalCandidateId },
  });
}

export async function persistAIExplanation(
  internalCandidateId: string,
  externalCandidateId: string,
  explanation: {
    text?: string;
    strengths?: string[];
    concerns?: string[];
    notMatchReasons?: string[];
    provider?: string;
    model?: string;
  },
  performedBy: string,
): Promise<IPairReview> {
  const internalOid = new Types.ObjectId(internalCandidateId);
  const externalOid = new Types.ObjectId(externalCandidateId);
  const performerOid = new Types.ObjectId(performedBy);
  const now = new Date();

  const aiExplanation = {
    text: explanation.text,
    strengths: explanation.strengths ?? [],
    concerns: explanation.concerns ?? [],
    notMatchReasons: explanation.notMatchReasons ?? [],
    generatedAt: now,
    provider: explanation.provider,
    model: explanation.model,
  };

  // Use $setOnInsert so the manualStatus stays "review_later" only if
  // the document is freshly created. AI commentary must never imply a
  // human judgment, so the stored manualStatus is purposely the most
  // neutral one available when there's no prior review.
  const doc = await PairReview.findOneAndUpdate(
    { internalCandidateId: internalOid, externalCandidateId: externalOid },
    {
      $set: { aiExplanation },
      $setOnInsert: {
        manualStatus: 'review_later',
        reviewedBy: performerOid,
        reviewedAt: now,
        history: [],
      },
    },
    { upsert: true, new: true },
  ).exec();

  await audit({
    entityType: AuditEntityType.PAIR_REVIEW,
    entityId: String(doc._id),
    actionType: AuditActionType.PAIR_REVIEW_AI_EXPLAINED,
    performedBy,
    metadata: {
      internalCandidateId,
      externalCandidateId,
      provider: explanation.provider,
      model: explanation.model,
    },
  });

  return doc;
}

// ── Ownership gate ──────────────────────────────────────────
//
// Pair reviews are operator-private judgments scoped to an internal
// candidate, so access is gated by ownership of that candidate — the
// same rule the rest of the app enforces on candidate writes. Without
// this, any authenticated shadchan could read/overwrite/clear another
// operator's decisions (and trigger billable AI) on a candidate they
// don't own.
export async function assertOwnsInternal(internalId: string, user: AuthUser): Promise<void> {
  const internal = await InternalCandidate.findById(internalId)
    .select('ownerUserId')
    .lean()
    .exec();
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);
  assertOwnership(
    (internal as { ownerUserId?: Types.ObjectId }).ownerUserId,
    user,
    { entity: 'internal candidate' },
  );
}

// ── AI explanation (advisory only) ──────────────────────────
//
// Calls the existing explainMatch AI helper with the engine output
// for the most recent suggestion, OR a fresh evaluation if no
// suggestion exists. Persists the result onto PairReview.aiExplanation
// so the board can show it without re-fetching. Ownership is enforced
// here (the candidate's owner / admin only) so the controller stays thin.
export interface ExplainAIResult {
  pairReview: IPairReview;
  ai: Awaited<ReturnType<typeof explainMatch>>['data'];
  metadata: Awaited<ReturnType<typeof explainMatch>>['metadata'];
}

export async function explainPairWithAI(
  internalId: string,
  externalId: string,
  user: AuthUser,
): Promise<ExplainAIResult> {
  const [internal, external, suggestion] = await Promise.all([
    InternalCandidate.findById(internalId).lean().exec(),
    ExternalCandidate.findById(externalId).lean().exec(),
    MatchSuggestion.findOne({
      internalCandidateId: new Types.ObjectId(internalId),
      externalCandidateId: new Types.ObjectId(externalId),
    })
      .sort({ updatedAt: -1 })
      .lean()
      .exec(),
  ]);
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);
  if (!external) throw new NotFoundError('ExternalCandidate', externalId);
  // Ownership gate: only the candidate's owner (or admin) may trigger
  // this write + billable AI call. Uses the already-loaded doc.
  assertOwnership(
    (internal as { ownerUserId?: Types.ObjectId }).ownerUserId,
    user,
    { entity: 'internal candidate' },
  );

  // If we have a persisted suggestion, use its scores; otherwise run an
  // on-demand evaluate so the AI gets real engine output to explain.
  // AI never sees raw DB docs — only briefs.
  let scoreData: {
    matchScore: number;
    confidenceScore: number;
    matchType: string;
    riskLevel: string;
    strengths: string[];
    attentionPoints: string[];
    scoreBreakdown: Array<{ dimension: string; score: number; detail: string }>;
    eligible: boolean;
    blockers: Array<{ code: string; message: string; overridable: string }>;
  };
  if (suggestion) {
    scoreData = {
      matchScore: suggestion.matchScore,
      confidenceScore: suggestion.confidenceScore,
      matchType: suggestion.matchType,
      riskLevel: suggestion.riskLevel,
      strengths: suggestion.strengths ?? [],
      attentionPoints: suggestion.attentionPoints ?? [],
      scoreBreakdown: (suggestion.scoreBreakdown ?? []).map((d) => ({
        dimension: d.dimension,
        score: d.score,
        detail: d.detail ?? '',
      })),
      eligible: suggestion.eligible,
      blockers: (suggestion.blockers ?? []).map((b) => ({
        code: b.code, message: b.message, overridable: b.overridable,
      })),
    };
  } else {
    const r = await evaluatePair(internalId, externalId, 'strict');
    scoreData = {
      matchScore: r.matchScore,
      confidenceScore: r.confidenceScore,
      matchType: r.matchType,
      riskLevel: r.riskLevel,
      strengths: r.strengths,
      attentionPoints: r.attentionPoints,
      scoreBreakdown: r.scoreBreakdown.map((d) => ({
        dimension: d.dimension,
        score: d.score,
        detail: d.detail ?? '',
      })),
      eligible: r.eligible,
      blockers: r.blockers.map((b) => ({
        code: b.code, message: b.message, overridable: b.overridable,
      })),
    };
  }

  const internalBrief = briefInternal(internal as Record<string, unknown>);
  const externalBrief = briefExternal(external as Record<string, unknown>);

  const ai = await explainMatch(
    {
      internal: internalBrief,
      external: externalBrief,
      ...scoreData,
    },
    { userId: user.id, suggestionId: suggestion ? String(suggestion._id) : undefined },
  );

  // Feed the reasons bank ("מאגר סיבות"): deterministic blockers
  // (stable, exact-reuse) + the AI's natural-language reasons (fuzzy
  // deduped). Best-effort — bank growth never blocks the explain.
  const bankInputs: Parameters<typeof ingestReasons>[0] = [
    ...scoreData.blockers.map((b) => ({
      category: 'blocker',
      text: b.message,
      source: 'deterministic' as const,
      stableCode: `blocker:${b.code}`,
      performedBy: user.id,
    })),
    ...ai.data.notMatchReasons.map((text) => ({
      category: 'ai',
      text,
      source: 'ai' as const,
      performedBy: user.id,
    })),
  ];
  await ingestReasons(bankInputs);

  const pairReview = await persistAIExplanation(
    internalId,
    externalId,
    {
      text: ai.data.summary,
      strengths: ai.data.strengths,
      concerns: ai.data.concerns,
      notMatchReasons: ai.data.notMatchReasons,
      provider: ai.metadata.provider,
      model: ai.metadata.model,
    },
    user.id,
  );

  return { pairReview, ai: ai.data, metadata: ai.metadata };
}

// ── Brief builders (AI input only — never raw DB docs) ──────

function computeAgeFromDob(dob: Date): number {
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

function briefInternal(d: Record<string, unknown>): {
  id: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  subSector?: string;
  lifestyleTone?: string;
  personalStatus?: string;
  lifeStage?: string;
  studyWorkDirection?: string;
  about?: string;
  whatSeeking?: string;
} {
  const dob = d['dateOfBirth'] as Date | undefined;
  return {
    id: String(d['_id']),
    firstName: d['firstName'] as string | undefined,
    lastName: d['lastName'] as string | undefined,
    gender: d['gender'] as string | undefined,
    age: dob ? computeAgeFromDob(new Date(dob)) : undefined,
    city: d['city'] as string | undefined,
    sectorGroup: d['sectorGroup'] as string | undefined,
    subSector: d['subSector'] as string | undefined,
    lifestyleTone: d['lifestyleTone'] as string | undefined,
    personalStatus: d['personalStatus'] as string | undefined,
    lifeStage: d['lifeStage'] as string | undefined,
    studyWorkDirection: d['studyWorkDirection'] as string | undefined,
    about: d['about'] as string | undefined,
    whatSeeking: d['whatSeeking'] as string | undefined,
  };
}

function briefExternal(d: Record<string, unknown>): {
  id: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  subSector?: string;
  lifestyleTone?: string;
  personalStatus?: string;
  lifeStage?: string;
  studyWorkDirection?: string;
  about?: string;
  whatSeeking?: string;
} {
  return {
    id: String(d['_id']),
    firstName: d['firstName'] as string | undefined,
    lastName: d['lastName'] as string | undefined,
    gender: d['gender'] as string | undefined,
    age: d['age'] as number | undefined,
    city: d['city'] as string | undefined,
    sectorGroup: d['sectorGroup'] as string | undefined,
    subSector: d['subSector'] as string | undefined,
    lifestyleTone: d['lifestyleTone'] as string | undefined,
    personalStatus: d['personalStatus'] as string | undefined,
    lifeStage: d['lifeStage'] as string | undefined,
    studyWorkDirection: d['studyWorkDirection'] as string | undefined,
    about: d['about'] as string | undefined,
    whatSeeking: d['whatSeeking'] as string | undefined,
  };
}
