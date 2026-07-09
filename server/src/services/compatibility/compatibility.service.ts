// ═══════════════════════════════════════════════════════════
// Compatibility service — builds the operator's compatibility
// board for a single internal candidate.
//
// Aggregates four authoritative sources, keyed by externalCandidateId:
//   1. Engine eligible results       → suitable / weak buckets
//   2. Engine blocked results        → blocked bucket
//   3. Existing MatchSuggestion rows → forced + historical buckets
//   4. Operator PairReview rows      → manual decisions overlay
//
// Rules:
//   - Engine output is the deterministic source of truth for status,
//     score, and blockers. Manual review is an OVERLAY: it never
//     mutates engine fields.
//   - Forced suggestions (forcedOverride=true) get pulled into
//     the FORCED bucket regardless of engine score.
//   - Historical outcomes (declined/dating/closed/expired) get
//     pulled into the HISTORICAL bucket regardless of engine score.
//   - Manual "not_suitable" overrides classification into BLOCKED-MANUAL
//     so the operator immediately sees their own past judgment.
//   - Every row carries a deterministic explanation built from the
//     engine output. AI commentary is included only if previously
//     persisted; this endpoint never triggers an AI call.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import type { SourceMode } from '@shadchanai/shared';
import {
  InternalCandidate,
  ExternalCandidate,
  MatchSuggestion,
  PairReview,
  type IMatchSuggestion,
  type IPairReview,
} from '../../models/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { evaluatePair as engineEvaluatePair } from '../matching/matching.engine.js';
import {
  toMatchableInternal,
  toMatchableExternal,
  buildEngineContext,
} from '../matching/matchable.mapper.js';
import { SUITABLE_SCORE_MIN, SUITABLE_CONFIDENCE_MIN } from '../matching/matching.constants.js';
import { buildSemanticSimilarityMap } from '../embedding/semantic-similarity.service.js';
import type {
  MatchResult,
  BlockerReason,
} from '../matching/matching.types.js';
import {
  buildDeterministicExplanation,
  type DeterministicExplanation,
} from './explanation.builder.js';

export type CompatibilityBucket =
  | 'suitable'
  | 'blocked'
  | 'weak'
  | 'forced'
  | 'historical';

export interface CompatibilityRow {
  externalCandidateId: string;
  bucket: CompatibilityBucket;

  // Identity (denormalized for the UI table)
  firstName?: string;
  lastName?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  personalStatus?: string;
  availabilityStatus?: string;

  // Engine signals
  engineEligible: boolean;
  matchScore?: number;
  confidenceScore?: number;
  matchType?: string;
  riskLevel?: string;
  strengths: string[];
  attentionPoints: string[];
  blockers: BlockerReason[];

  // Aggregate flag for force-eligibility (mirrors BlockedMatchItem):
  //   'none'        → engine has at least one non-overridable blocker
  //   'with_reason' → blockers exist but all are overridable
  //   'not_blocked' → engine considers pair eligible
  forceability: 'none' | 'with_reason' | 'not_blocked';

  // Deterministic explanation (always populated from engine output).
  // The UI MUST render this; AI commentary is supplementary.
  explanation: DeterministicExplanation;

  // Existing match suggestion (if any) — same key as the pair
  matchSuggestionId?: string;
  matchStatus?: string;
  forcedOverride?: boolean;
  matchClosedAt?: string;
  matchCloseReason?: string;
  sideAResponseStatus?: string;
  sideBResponseStatus?: string;
  datingStartedAt?: string;

  // Operator memory
  manualStatus?: string;
  operatorReason?: string;
  outcomeReason?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewHistoryCount?: number;
  pairReviewId?: string;

  // Cached AI commentary (never auto-fetched here)
  aiExplanation?: {
    text?: string;
    strengths?: string[];
    concerns?: string[];
    notMatchReasons?: string[];
    generatedAt?: string;
    provider?: string;
  };
}

export interface CompatibilityBoard {
  internalCandidateId: string;
  generatedAt: string;
  externalsConsidered: number;
  totals: Record<CompatibilityBucket, number>;
  rows: CompatibilityRow[];
}

const HISTORICAL_STATUSES = new Set([
  'declined_side_a',
  'declined_side_b',
  'dating',
  'closed',
  'expired',
]);

export async function buildBoardForInternal(
  internalId: string,
  mode: SourceMode,
  options: { externalLimit?: number } = {},
): Promise<CompatibilityBoard> {
  const internal = await InternalCandidate.findById(internalId).lean().exec();
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);

  const oppositeGender = (internal as { gender?: string }).gender === 'male' ? 'female' : 'male';

  // Gather candidate pool: opposite-gender externals (active OR with
  // any pre-existing match/review for this internal — so historical
  // and review entries surface even if the external is now stale).
  const [activeExternals, suggestions, reviews] = await Promise.all([
    ExternalCandidate.find({
      gender: oppositeGender,
      status: 'active',
      availabilityStatus: { $in: ['available', 'unknown'] },
    }).lean().exec(),
    MatchSuggestion.find({
      internalCandidateId: new Types.ObjectId(internalId),
    })
      .sort({ updatedAt: -1 })
      .lean()
      .exec() as unknown as Promise<IMatchSuggestion[]>,
    PairReview.find({
      internalCandidateId: new Types.ObjectId(internalId),
    })
      .lean()
      .exec() as unknown as Promise<IPairReview[]>,
  ]);

  // Index suggestions + reviews by externalCandidateId
  const suggestionByExternal = new Map<string, IMatchSuggestion>();
  // Keep only the most recent suggestion per pair for the board view.
  for (const s of suggestions) {
    const key = String(s.externalCandidateId);
    if (!suggestionByExternal.has(key)) suggestionByExternal.set(key, s);
  }
  const reviewByExternal = new Map<string, IPairReview>();
  for (const r of reviews) {
    reviewByExternal.set(String(r.externalCandidateId), r);
  }

  // Pull supplementary externals referenced by suggestions/reviews
  // that aren't in the active pool.
  const activeIds = new Set(activeExternals.map((e) => String(e._id)));
  const extraIds: Types.ObjectId[] = [];
  for (const id of suggestionByExternal.keys()) if (!activeIds.has(id)) extraIds.push(new Types.ObjectId(id));
  for (const id of reviewByExternal.keys()) if (!activeIds.has(id) && !extraIds.some((x) => String(x) === id)) {
    extraIds.push(new Types.ObjectId(id));
  }
  const extraExternals = extraIds.length > 0
    ? await ExternalCandidate.find({ _id: { $in: extraIds } }).lean().exec()
    : [];

  const externalPool = [...activeExternals, ...extraExternals];

  // Build engine context once. Semantic map (admin-gated add-on) is
  // computed for the whole pool up front — pure CPU per pair after that.
  const ctx = await buildEngineContext(internalId, mode);
  const semantic = await buildSemanticSimilarityMap(
    internalId,
    externalPool.map((e) => String(e._id)),
  );
  if (semantic) ctx.semanticSimilarities = semantic;
  const matchableInternal = toMatchableInternal(internal as Record<string, unknown>);

  const rows: CompatibilityRow[] = [];
  for (const ext of externalPool) {
    const externalId = String(ext._id);
    const result = engineEvaluatePair(
      matchableInternal,
      toMatchableExternal(ext as Record<string, unknown>),
      ctx,
    );

    const suggestion = suggestionByExternal.get(externalId);
    const review = reviewByExternal.get(externalId);

    const bucket = classify(result, suggestion, review);
    const forceability = computeForceability(result);
    const explanation = buildDeterministicExplanation({
      bucket,
      result,
      suggestion,
      review,
      external: ext as Record<string, unknown>,
    });

    rows.push({
      externalCandidateId: externalId,
      bucket,
      firstName: ext['firstName'] as string | undefined,
      lastName: ext['lastName'] as string | undefined,
      age: ext['age'] as number | undefined,
      city: ext['city'] as string | undefined,
      sectorGroup: ext['sectorGroup'] as string | undefined,
      personalStatus: ext['personalStatus'] as string | undefined,
      availabilityStatus: ext['availabilityStatus'] as string | undefined,
      engineEligible: result.eligible,
      matchScore: result.matchScore,
      confidenceScore: result.confidenceScore,
      matchType: result.matchType,
      riskLevel: result.riskLevel,
      strengths: result.strengths,
      attentionPoints: result.attentionPoints,
      blockers: result.blockers,
      forceability,
      explanation,
      matchSuggestionId: suggestion ? String(suggestion._id) : undefined,
      matchStatus: suggestion?.status,
      forcedOverride: suggestion?.forcedOverride,
      matchClosedAt: suggestion?.closedAt ? new Date(suggestion.closedAt).toISOString() : undefined,
      matchCloseReason: suggestion?.closeReason,
      sideAResponseStatus: suggestion?.sideAResponse?.status,
      sideBResponseStatus: suggestion?.sideBResponse?.status,
      datingStartedAt: suggestion?.datingStartedAt
        ? new Date(suggestion.datingStartedAt).toISOString()
        : undefined,
      manualStatus: review?.manualStatus,
      operatorReason: review?.operatorReason,
      outcomeReason: review?.outcomeReason,
      reviewedAt: review?.reviewedAt ? new Date(review.reviewedAt).toISOString() : undefined,
      reviewedBy: review?.reviewedBy ? String(review.reviewedBy) : undefined,
      reviewHistoryCount: review?.history?.length ?? 0,
      pairReviewId: review ? String(review._id) : undefined,
      aiExplanation: review?.aiExplanation
        ? {
          text: review.aiExplanation.text,
          strengths: review.aiExplanation.strengths,
          concerns: review.aiExplanation.concerns,
          notMatchReasons: review.aiExplanation.notMatchReasons,
          generatedAt: review.aiExplanation.generatedAt
            ? new Date(review.aiExplanation.generatedAt).toISOString()
            : undefined,
          provider: review.aiExplanation.provider,
        }
        : undefined,
    });
  }

  // Sort within bucket: suitable & weak by score desc; blocked by
  // forceability ('with_reason' first); historical by closedAt desc.
  rows.sort((a, b) => bucketRank(a.bucket) - bucketRank(b.bucket)
    || compareWithinBucket(a, b));

  const totals: Record<CompatibilityBucket, number> = {
    suitable: 0, blocked: 0, weak: 0, forced: 0, historical: 0,
  };
  for (const r of rows) totals[r.bucket] += 1;

  const limit = options.externalLimit ?? 200;
  return {
    internalCandidateId: internalId,
    generatedAt: new Date().toISOString(),
    externalsConsidered: externalPool.length,
    totals,
    rows: rows.slice(0, limit),
  };
}

// ── Classification ────────────────────────────────────────

function classify(
  result: MatchResult,
  suggestion: IMatchSuggestion | undefined,
  _review: IPairReview | undefined,
): CompatibilityBucket {
  // 1. Existing terminal-state match → historical
  if (suggestion && HISTORICAL_STATUSES.has(suggestion.status)) {
    return 'historical';
  }

  // 2. Forced active match → forced
  if (suggestion?.forcedOverride && !HISTORICAL_STATUSES.has(suggestion.status)) {
    return 'forced';
  }

  // 3. Engine ineligible → blocked
  if (!result.eligible) return 'blocked';

  // 4. Eligible but low score / confidence → weak
  if (
    result.matchScore < SUITABLE_SCORE_MIN
    || result.confidenceScore < SUITABLE_CONFIDENCE_MIN
    || result.matchType === 'risky'
  ) {
    return 'weak';
  }

  // 5. Eligible + healthy score → suitable
  return 'suitable';
}

function computeForceability(result: MatchResult): CompatibilityRow['forceability'] {
  if (result.eligible) return 'not_blocked';
  const anyNonOverridable = result.blockers.some((b) => b.overridable === 'none');
  return anyNonOverridable ? 'none' : 'with_reason';
}

function bucketRank(b: CompatibilityBucket): number {
  switch (b) {
    case 'suitable':   return 0;
    case 'forced':     return 1;
    case 'weak':       return 2;
    case 'blocked':    return 3;
    case 'historical': return 4;
  }
}

function compareWithinBucket(a: CompatibilityRow, b: CompatibilityRow): number {
  if (a.bucket === 'historical') {
    const aT = a.matchClosedAt ? Date.parse(a.matchClosedAt) : 0;
    const bT = b.matchClosedAt ? Date.parse(b.matchClosedAt) : 0;
    return bT - aT;
  }
  if (a.bucket === 'blocked') {
    // 'with_reason' first (operator can act), then 'none'
    const order: Record<CompatibilityRow['forceability'], number> = {
      with_reason: 0, none: 1, not_blocked: 2,
    };
    return order[a.forceability] - order[b.forceability];
  }
  // Suitable / weak / forced → score desc
  return (b.matchScore ?? 0) - (a.matchScore ?? 0);
}

// ── On-demand pair check (single pair, full detail) ───────

export interface PairCheckResult {
  internalCandidateId: string;
  externalCandidateId: string;
  externalFound: boolean;
  external?: {
    firstName?: string;
    lastName?: string;
    age?: number;
    city?: string;
    sectorGroup?: string;
    personalStatus?: string;
    availabilityStatus?: string;
    status?: string;
  };
  engine?: MatchResult;
  forceability: 'none' | 'with_reason' | 'not_blocked';
  bucket: CompatibilityBucket;
  explanation: DeterministicExplanation;
  existingSuggestion?: {
    matchSuggestionId: string;
    status: string;
    forcedOverride: boolean;
    closedAt?: string;
    closeReason?: string;
  };
  pairReview?: {
    pairReviewId: string;
    manualStatus: string;
    operatorReason?: string;
    outcomeReason?: string;
    reviewedAt: string;
    reviewedBy: string;
    historyCount: number;
    aiExplanation?: {
      text?: string;
      strengths?: string[];
      concerns?: string[];
      notMatchReasons?: string[];
      generatedAt?: string;
      provider?: string;
    };
  };
}

export async function checkPair(
  internalId: string,
  externalId: string,
  mode: SourceMode,
): Promise<PairCheckResult> {
  const [internal, external, suggestion, review] = await Promise.all([
    InternalCandidate.findById(internalId).lean().exec(),
    ExternalCandidate.findById(externalId).lean().exec(),
    MatchSuggestion.findOne({
      internalCandidateId: new Types.ObjectId(internalId),
      externalCandidateId: new Types.ObjectId(externalId),
    })
      .sort({ updatedAt: -1 })
      .lean()
      .exec() as unknown as Promise<IMatchSuggestion | null>,
    PairReview.findOne({
      internalCandidateId: new Types.ObjectId(internalId),
      externalCandidateId: new Types.ObjectId(externalId),
    })
      .lean()
      .exec() as unknown as Promise<IPairReview | null>,
  ]);
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);

  if (!external) {
    return {
      internalCandidateId: internalId,
      externalCandidateId: externalId,
      externalFound: false,
      forceability: 'none',
      bucket: 'blocked',
      explanation: {
        primary: 'המועמד החיצוני לא נמצא',
        positives: [],
        negatives: ['המועמד החיצוני שנבחר כבר אינו קיים במאגר'],
        warnings: [],
        manualOverlay: undefined,
      },
    };
  }

  const ctx = await buildEngineContext(internalId, mode);
  const semantic = await buildSemanticSimilarityMap(internalId, [externalId]);
  if (semantic) ctx.semanticSimilarities = semantic;
  const result = engineEvaluatePair(
    toMatchableInternal(internal as Record<string, unknown>),
    toMatchableExternal(external as Record<string, unknown>),
    ctx,
  );

  const bucket = classify(result, suggestion ?? undefined, review ?? undefined);
  const forceability = computeForceability(result);
  const explanation = buildDeterministicExplanation({
    bucket,
    result,
    suggestion: suggestion ?? undefined,
    review: review ?? undefined,
    external: external as Record<string, unknown>,
  });

  return {
    internalCandidateId: internalId,
    externalCandidateId: externalId,
    externalFound: true,
    external: {
      firstName: external['firstName'] as string | undefined,
      lastName: external['lastName'] as string | undefined,
      age: external['age'] as number | undefined,
      city: external['city'] as string | undefined,
      sectorGroup: external['sectorGroup'] as string | undefined,
      personalStatus: external['personalStatus'] as string | undefined,
      availabilityStatus: external['availabilityStatus'] as string | undefined,
      status: external['status'] as string | undefined,
    },
    engine: result,
    forceability,
    bucket,
    explanation,
    existingSuggestion: suggestion
      ? {
        matchSuggestionId: String(suggestion._id),
        status: suggestion.status,
        forcedOverride: !!suggestion.forcedOverride,
        closedAt: suggestion.closedAt ? new Date(suggestion.closedAt).toISOString() : undefined,
        closeReason: suggestion.closeReason,
      }
      : undefined,
    pairReview: review
      ? {
        pairReviewId: String(review._id),
        manualStatus: review.manualStatus,
        operatorReason: review.operatorReason,
        outcomeReason: review.outcomeReason,
        reviewedAt: new Date(review.reviewedAt).toISOString(),
        reviewedBy: String(review.reviewedBy),
        historyCount: review.history?.length ?? 0,
        aiExplanation: review.aiExplanation
          ? {
            text: review.aiExplanation.text,
            strengths: review.aiExplanation.strengths,
            concerns: review.aiExplanation.concerns,
            notMatchReasons: review.aiExplanation.notMatchReasons,
            generatedAt: review.aiExplanation.generatedAt
              ? new Date(review.aiExplanation.generatedAt).toISOString()
              : undefined,
            provider: review.aiExplanation.provider,
          }
          : undefined,
      }
      : undefined,
  };
}
