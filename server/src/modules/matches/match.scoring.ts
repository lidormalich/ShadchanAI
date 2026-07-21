// ═══════════════════════════════════════════════════════════
// ShadchanAI — Match scoring (engine evaluation, no persistence)
//
// All functions here run the deterministic engine against live
// candidate data and return results. None of them write business
// state. The engine is the SOLE source of truth for scoring.
// ═══════════════════════════════════════════════════════════

import type { SourceMode } from '@shadchanai/shared';
import {
  InternalCandidate,
  ExternalCandidate,
} from '../../models/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { evaluatePair as engineEvaluatePair } from '../../services/matching/matching.engine.js';
import {
  toMatchableInternal,
  toMatchableExternal,
  buildEngineContext,
} from '../../services/matching/matchable.mapper.js';
import { computeReadiness } from '../candidates/internal-candidate.service.js';
import type { MatchResult } from '../../services/matching/matching.types.js';
import { buildSemanticSimilarityMap } from '../../services/embedding/semantic-similarity.service.js';
import { getMatchById } from './match.query.js';

// Re-export the context builder so existing callers that imported it
// from the matches module keep working.
export { buildEngineContext };

// ── Evaluate pair (engine only, no persistence) ──────────

export async function evaluatePair(
  internalId: string,
  externalId: string,
  mode: SourceMode,
): Promise<MatchResult> {
  const [internal, external] = await Promise.all([
    InternalCandidate.findById(internalId).lean().exec(),
    ExternalCandidate.findById(externalId).lean().exec(),
  ]);
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);
  if (!external) throw new NotFoundError('ExternalCandidate', externalId);

  const ctx = await buildEngineContext(internalId, mode);
  // Optional semantic add-on (admin-gated, fail-soft): feeds the
  // flexibility dimension; absent map = pure deterministic scoring.
  const semantic = await buildSemanticSimilarityMap(internalId, [externalId]);
  if (semantic) ctx.semanticSimilarities = semantic;
  return engineEvaluatePair(
    toMatchableInternal(internal),
    toMatchableExternal(external),
    ctx,
  );
}

// ── Preview send readiness ───────────────────────────────

export async function previewSendReadiness(id: string): Promise<{
  matchId: string;
  canSend: boolean;
  blockers: string[];
  internalCandidateReadiness: ReturnType<typeof computeReadiness>;
  externalCandidateAvailable: boolean;
  engineRecommendedAction: string;
}> {
  const match = await getMatchById(id);
  const [internal, external] = await Promise.all([
    InternalCandidate.findById(match.internalCandidateId).lean().exec(),
    ExternalCandidate.findById(match.externalCandidateId).lean().exec(),
  ]);
  if (!internal) throw new NotFoundError('InternalCandidate', String(match.internalCandidateId));
  if (!external) throw new NotFoundError('ExternalCandidate', String(match.externalCandidateId));

  const readiness = computeReadiness(internal as unknown as Parameters<typeof computeReadiness>[0]);
  const blockers = [...readiness.sendReadinessBlockers];

  const externalAvailable = external.status === 'active'
    && external.availabilityStatus !== 'unavailable'
    && external.availabilityStatus !== 'dating';
  if (!externalAvailable) blockers.push(`המועמד החיצוני אינו זמין (${external.availabilityStatus})`);

  if (external.shareCard && !external.shareCard.approvedForShare) {
    blockers.push('כרטיס השיתוף החיצוני לא אושר');
  }

  if (match.status === 'closed' || match.status === 'expired') {
    blockers.push(`ההתאמה בסטטוס סופי: ${match.status}`);
  }

  if (match.isDeferred) {
    blockers.push('ההתאמה נדחתה כרגע');
  }

  const canSend = blockers.length === 0;

  return {
    matchId: id,
    canSend,
    blockers,
    internalCandidateReadiness: readiness,
    externalCandidateAvailable: externalAvailable,
    engineRecommendedAction: match.recommendedAction,
  };
}

// ── Find matches for an internal candidate (bulk evaluate) ──
//
// Runs the deterministic engine against every currently-available
// external candidate of the opposite gender. No persistence — returns
// the top-N eligible results sorted by matchScore. Use to surface
// candidate matches in the UI; the operator then picks one to turn
// into a persisted MatchSuggestion via createManualSuggestion.

export interface FindMatchItem {
  externalCandidateId: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  city?: string | undefined;
  age?: number | undefined;
  sectorGroup?: string | undefined;
  matchScore: number;
  confidenceScore: number;
  matchType: MatchResult['matchType'];
  riskLevel: MatchResult['riskLevel'];
  strengths: string[];
  attentionPoints: string[];
  recommendedAction: MatchResult['recommendedAction'];
}

// Upper bound on how many externals we pull into memory and score in a
// single request. Scoring is pure CPU but still O(pool); this caps the
// blast radius as the candidate database grows. Newest externals are
// scored first (recency sort). Tune here if the active pool outgrows it.
const SCORING_POOL_CAP = 300;

export async function findMatchesForInternal(
  internalId: string,
  mode: SourceMode,
  limit?: number,
): Promise<FindMatchItem[]> {
  const internal = await InternalCandidate.findById(internalId).lean().exec();
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);

  const oppositeGender = (internal as { gender?: string }).gender === 'male' ? 'female' : 'male';

  const externals = await ExternalCandidate.find({
    gender: oppositeGender,
    status: 'active',
    availabilityStatus: { $in: ['available', 'unknown'] },
  })
    .sort({ createdAt: -1 })
    .limit(SCORING_POOL_CAP)
    .lean()
    .exec();

  const ctx = await buildEngineContext(internalId, mode);
  const semantic = await buildSemanticSimilarityMap(
    internalId,
    externals.map((e) => String(e._id)),
  );
  if (semantic) ctx.semanticSimilarities = semantic;
  const matchable = toMatchableInternal(internal);

  const results: FindMatchItem[] = [];
  for (const ext of externals) {
    const r = engineEvaluatePair(matchable, toMatchableExternal(ext), ctx);
    if (!r.eligible) continue;
    results.push({
      externalCandidateId: String(ext._id),
      firstName: ext['firstName'] as string | undefined,
      lastName: ext['lastName'] as string | undefined,
      city: ext['city'] as string | undefined,
      age: ext['age'] as number | undefined,
      sectorGroup: ext['sectorGroup'] as string | undefined,
      matchScore: r.matchScore,
      confidenceScore: r.confidenceScore,
      matchType: r.matchType,
      riskLevel: r.riskLevel,
      strengths: r.strengths,
      attentionPoints: r.attentionPoints,
      recommendedAction: r.recommendedAction,
    });
  }

  results.sort((a, b) => b.matchScore - a.matchScore);
  // Default: return every eligible scored candidate (the UI loads them in
  // chunks client-side). An explicit `limit` still caps the response.
  return limit != null ? results.slice(0, limit) : results;
}

// ── Find blocked pairs for an internal candidate ─────────
//
// Counterpart to findMatchesForInternal: returns pairs the engine
// rejected, with full BlockerReason metadata. The UI uses this
// to render the "blocked candidates" section alongside suggestions.
export interface BlockedMatchItem {
  externalCandidateId: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  city?: string | undefined;
  age?: number | undefined;
  sectorGroup?: string | undefined;
  blockers: Array<{
    code: string;
    severity: string;
    overridable: string;
    message: string;
    detail?: Record<string, unknown>;
  }>;
  // Aggregate classification for the whole pair:
  //   'none'        → at least one blocker is non-overridable (force rejected)
  //   'with_reason' → every blocker is overridable with justification
  aggregateOverridable: 'none' | 'with_reason';
}

export async function findBlockedForInternal(
  internalId: string,
  mode: SourceMode,
  limit = 50,
): Promise<BlockedMatchItem[]> {
  const internal = await InternalCandidate.findById(internalId).lean().exec();
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);

  const oppositeGender = (internal as { gender?: string }).gender === 'male' ? 'female' : 'male';

  // Same pool the eligible-find uses: active externals of opposite
  // gender. Broadening would pollute the list with same-gender pairs
  // (non-overridable blocker). Bounded by the same cap so a candidate
  // with few blockers doesn't score the entire collection.
  const externals = await ExternalCandidate.find({
    gender: oppositeGender,
    status: 'active',
    availabilityStatus: { $in: ['available', 'unknown'] },
  })
    .sort({ createdAt: -1 })
    .limit(SCORING_POOL_CAP)
    .lean()
    .exec();

  const ctx = await buildEngineContext(internalId, mode);
  const matchable = toMatchableInternal(internal);

  const results: BlockedMatchItem[] = [];
  for (const ext of externals) {
    const r = engineEvaluatePair(matchable, toMatchableExternal(ext), ctx);
    if (r.eligible) continue;
    const anyNonOverridable = r.blockers.some((b) => b.overridable === 'none');
    results.push({
      externalCandidateId: String(ext._id),
      firstName: ext['firstName'] as string | undefined,
      lastName: ext['lastName'] as string | undefined,
      city: ext['city'] as string | undefined,
      age: ext['age'] as number | undefined,
      sectorGroup: ext['sectorGroup'] as string | undefined,
      blockers: r.blockers,
      aggregateOverridable: anyNonOverridable ? 'none' : 'with_reason',
    });
    if (results.length >= limit) break;
  }
  return results;
}
