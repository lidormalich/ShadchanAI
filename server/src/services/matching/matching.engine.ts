// ═══════════════════════════════════════════════════════════
// ShadchanAI — Matching Engine Orchestrator
//
// This is the single entry point for deterministic matching.
// It ties together:
//   1. Hard rules   → eligibility check
//   2. Soft scoring  → 8-dimension weighted score
//   3. Penalties     → actionability adjustments
//   4. Confidence    → data quality assessment
//   5. Classification → matchType + riskLevel
//   6. Recommendation → what action to take
//
// The engine is the SOURCE OF TRUTH for all match decisions.
// AI is NEVER involved in scoring, filtering, or classification.
// ═══════════════════════════════════════════════════════════

import { MatchType, RiskLevel, AgeConfidence, ScoringDimension } from '@shadchanai/shared';
import type {
  MatchableInternal,
  MatchableExternal,
  MatchingContext,
  MatchResult,
  MatchingWeights,
  RecommendedAction,
  SendStrategy,
  DimensionScore,
  BlockerReason,
} from './matching.types.js';
import { evaluateHardRules } from './matching.rules.js';
import { scorePair, type ScoreResult } from './matching.score.js';
import { computePenalties } from './matching.penalties.js';
import {
  DEFAULT_WEIGHTS,
  MATCH_TYPE_THRESHOLDS,
  MODE_CONFIG,
  CONFIDENCE,
  SECTOR_RISK,
} from './matching.constants.js';
import { combinedSectorCloseness } from './matching.matrix.js';

// ── Public API ────────────────────────────────────────────

/**
 * Evaluate a single internal-external pair. Returns a full MatchResult
 * regardless of eligibility (blocked pairs have eligible=false with blockers).
 */
export function evaluatePair(
  internal: MatchableInternal,
  external: MatchableExternal,
  context: MatchingContext,
  weights: MatchingWeights = DEFAULT_WEIGHTS,
): MatchResult {
  // Step 1: Hard rules
  const hardRuleResult = evaluateHardRules(internal, external, context);

  if (!hardRuleResult.eligible) {
    return makeBlockedResult(internal, external, hardRuleResult.blockers, context);
  }

  // Step 2: Score across 8 dimensions
  const scoreResult = scorePair(internal, external, context, weights);

  // Step 3: Compute penalties
  const penalties = computePenalties(internal, external, context);

  // Step 4: Apply penalties to raw score
  const matchScore = Math.max(0, Math.min(100, scoreResult.rawScore - penalties.totalPenalty));

  // Step 5: Compute confidence score
  const confidenceScore = computeConfidence(internal, external);

  // Step 6: Compute risk pattern (composite signal for classification)
  const riskPattern = computeRiskPattern(internal, external, scoreResult);

  // Step 7: Classify matchType (score + risk pattern)
  const matchType = classifyMatchType(
    matchScore, confidenceScore, internal, external, riskPattern,
  );

  // Step 8: Compute risk level
  const riskLevel = computeRiskLevel(matchScore, confidenceScore, internal, external, riskPattern);

  // Step 9: Determine recommended action
  const recommendedAction = determineAction(
    matchType, riskLevel, confidenceScore, internal, riskPattern,
  );

  // Step 10: Determine send strategy
  const sendStrategy = determineSendStrategy(matchType, recommendedAction);

  // Step 10: Get semantic similarity if available
  const semanticSimilarityScore = context.semanticSimilarities?.get(external._id);

  return {
    internalCandidateId: internal._id,
    externalCandidateId: external._id,
    eligible: true,
    hardBlockers: [],
    blockers: [],
    matchScore,
    rawScore: scoreResult.rawScore,
    confidenceScore,
    matchType,
    riskLevel,
    scoreBreakdown: scoreResult.breakdown,
    strengths: scoreResult.strengths,
    attentionPoints: scoreResult.attentionPoints,
    overrideReasons: scoreResult.overrideReasons,
    flexibilityOverrideApplied: scoreResult.flexibilityOverrideApplied,
    recommendedAction,
    sendStrategy,
    sourceMode: context.mode,
    penalties,
    semanticSimilarityScore,
  };
}

/**
 * Evaluate an internal candidate against multiple external candidates.
 * Returns sorted results filtered by mode.
 */
export function findMatches(
  internal: MatchableInternal,
  externals: MatchableExternal[],
  context: MatchingContext,
  weights: MatchingWeights = DEFAULT_WEIGHTS,
): MatchResult[] {
  const config = MODE_CONFIG[context.mode];

  const results: MatchResult[] = [];

  for (const external of externals) {
    const result = evaluatePair(internal, external, context, weights);

    // Skip ineligible
    if (!result.eligible) continue;

    // Skip below mode floor
    if (result.matchScore < config.scoreFloor) continue;

    // Skip disallowed match types in strict mode
    if (!(config.allowedMatchTypes as readonly string[]).includes(result.matchType)) continue;

    results.push(result);
  }

  // Sort by matchScore descending, then confidenceScore descending
  results.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    return b.confidenceScore - a.confidenceScore;
  });

  return results.slice(0, config.maxResults);
}

// ── Confidence Score ──────────────────────────────────────
//
// Reflects how much data the engine had to work with. A match
// can have high matchScore (looks great on paper) but low
// confidence (not enough data to be sure).

function computeConfidence(
  internal: MatchableInternal,
  external: MatchableExternal,
): number {
  let score = CONFIDENCE.BASE;

  // ── External candidate data gaps ────────────────────────
  if (!external.gender) score -= CONFIDENCE.MISSING_GENDER;
  if (!external.age) score -= CONFIDENCE.MISSING_AGE;
  if (!external.sectorGroup) score -= CONFIDENCE.MISSING_SECTOR;
  if (!external.city) score -= CONFIDENCE.MISSING_CITY;
  if (!external.lifestyleTone) score -= CONFIDENCE.MISSING_LIFESTYLE;
  if (!external.studyWorkDirection) score -= CONFIDENCE.MISSING_STUDY_WORK;
  if (!external.lifeStage) score -= CONFIDENCE.MISSING_LIFE_STAGE;
  if (!external.personalStatus) score -= CONFIDENCE.MISSING_PERSONAL_STATUS;

  // ── Age reliability ─────────────────────────────────────
  if (external.ageReliability?.ageConfidence) {
    switch (external.ageReliability.ageConfidence) {
      case AgeConfidence.APPROXIMATE:
        score -= CONFIDENCE.AGE_APPROXIMATE;
        break;
      case AgeConfidence.ESTIMATED:
        score -= CONFIDENCE.AGE_ESTIMATED;
        break;
      case AgeConfidence.UNKNOWN:
        score -= CONFIDENCE.AGE_UNKNOWN;
        break;
      // EXACT: no deduction
    }
  } else if (external.age) {
    // Age exists but no reliability info → mild deduction
    score -= CONFIDENCE.AGE_APPROXIMATE;
  }

  // ── External profile staleness ──────────────────────────
  if (external.staleAt) {
    score -= CONFIDENCE.STALE_DEDUCTION;
  }

  // ── Internal profile completeness ───────────────────────
  if (internal.profileCompletion < CONFIDENCE.LOW_COMPLETION_THRESHOLD) {
    score -= CONFIDENCE.LOW_COMPLETION_DEDUCTION;
  }

  // ── Internal verification recency ───────────────────────
  if (internal.lastVerifiedAt) {
    const daysSince = daysBetween(internal.lastVerifiedAt, new Date());
    if (daysSince > CONFIDENCE.UNVERIFIED_DAYS) {
      score -= CONFIDENCE.UNVERIFIED_DEDUCTION;
    }
  } else {
    // Never verified
    score -= CONFIDENCE.UNVERIFIED_DEDUCTION;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── Risk Pattern ──────────────────────────────────────────
//
// A composite signal that captures match-level risk factors
// that raw score + confidence alone miss. Used by both match-
// type classification and risk-level computation to detect
// patterns like severe-lifestyle-gap, multiple-overrides,
// second-chapter-with-lifestyle-gap, etc.

interface RiskPattern {
  lifestyleGapSeverity: 'none' | 'mild' | 'severe';
  ageDeviationSeverity: 'none' | 'mild' | 'severe';
  sectorCloseness: number;
  overrideCount: number;
  isSecondChapter: boolean;
  attentionPointCount: number;
  /** Composite 0–10+ — higher means more risk factors are compounding */
  riskScore: number;
}

function computeRiskPattern(
  internal: MatchableInternal,
  external: MatchableExternal,
  scoreResult: ScoreResult,
): RiskPattern {
  const lifestyleDim = findDimension(scoreResult.breakdown, ScoringDimension.LIFESTYLE);
  const ageDim = findDimension(scoreResult.breakdown, ScoringDimension.AGE);

  const lifestyleSeverity: 'none' | 'mild' | 'severe' =
    lifestyleDim && lifestyleDim.score < 30 ? 'severe'
    : lifestyleDim && lifestyleDim.score < 55 ? 'mild'
    : 'none';

  const ageSeverity: 'none' | 'mild' | 'severe' =
    ageDim && ageDim.score < 30 ? 'severe'
    : ageDim && ageDim.score < 55 ? 'mild'
    : 'none';

  const sectorCloseness = combinedSectorCloseness(
    internal.sectorGroup, internal.subSector,
    external.sectorGroup, external.subSector,
  );

  const isSecondChapter =
    ['divorced', 'separated', 'widowed'].includes(internal.personalStatus) ||
    (external.personalStatus !== undefined &&
      ['divorced', 'separated', 'widowed'].includes(external.personalStatus));

  // Compose risk score
  let riskScore = 0;
  if (lifestyleSeverity === 'severe') riskScore += 3;
  else if (lifestyleSeverity === 'mild') riskScore += 1;

  if (ageSeverity === 'severe') riskScore += 2;
  else if (ageSeverity === 'mild') riskScore += 1;

  if (scoreResult.overrideReasons.length >= 3) riskScore += 2;
  else if (scoreResult.overrideReasons.length >= 2) riskScore += 1;

  if (isSecondChapter && lifestyleSeverity === 'severe') riskScore += 2;

  if (scoreResult.attentionPoints.length >= 3) riskScore += 1;

  // Sector + lifestyle compound: cross-sector with lifestyle gap is a known risk
  if (sectorCloseness < SECTOR_RISK.RISK_THRESHOLD && lifestyleSeverity !== 'none') {
    riskScore += 2;
  }

  return {
    lifestyleGapSeverity: lifestyleSeverity,
    ageDeviationSeverity: ageSeverity,
    sectorCloseness,
    overrideCount: scoreResult.overrideReasons.length,
    isSecondChapter,
    attentionPointCount: scoreResult.attentionPoints.length,
    riskScore,
  };
}

// ── Match Type Classification ─────────────────────────────
//
// Deterministic classification based on score, confidence,
// AND the risk-pattern composite. NOT an AI judgment.
//
// Flow:
//   1. Hard indicators force RISKY (very low confidence / very low sector
//      closeness / very high risk pattern score).
//   2. Score + confidence determine the baseline tier.
//   3. Risk pattern can downgrade (but never upgrade) the tier.

function classifyMatchType(
  matchScore: number,
  confidenceScore: number,
  internal: MatchableInternal,
  external: MatchableExternal,
  riskPattern: RiskPattern,
): MatchType {
  // ── Hard risky indicators ────────────────────────────
  if (
    riskPattern.sectorCloseness < SECTOR_RISK.HIGH_RISK_THRESHOLD ||
    confidenceScore < 30 ||
    riskPattern.riskScore >= 7
  ) {
    return MatchType.RISKY;
  }

  // ── Baseline tier from score + confidence ─────────────
  let tier: MatchType;
  if (
    matchScore >= MATCH_TYPE_THRESHOLDS.safe.minScore &&
    confidenceScore >= MATCH_TYPE_THRESHOLDS.safe.minConfidence &&
    riskPattern.sectorCloseness >= 0.5
  ) {
    tier = MatchType.SAFE;
  } else if (
    matchScore >= MATCH_TYPE_THRESHOLDS.balanced.minScore &&
    confidenceScore >= MATCH_TYPE_THRESHOLDS.balanced.minConfidence
  ) {
    tier = MatchType.BALANCED;
  } else if (matchScore >= MATCH_TYPE_THRESHOLDS.creative.minScore) {
    tier = MatchType.CREATIVE;
  } else {
    tier = MatchType.RISKY;
  }

  // ── Risk-pattern downgrade rules (never upgrade) ──────

  // SAFE → BALANCED downgrades
  if (tier === MatchType.SAFE) {
    if (
      riskPattern.riskScore >= 4 ||
      riskPattern.overrideCount >= 3 ||
      (riskPattern.isSecondChapter && riskPattern.lifestyleGapSeverity === 'severe') ||
      riskPattern.ageDeviationSeverity === 'severe'
    ) {
      tier = MatchType.BALANCED;
    }
  }

  // BALANCED → CREATIVE downgrades
  if (tier === MatchType.BALANCED) {
    if (
      riskPattern.riskScore >= 5 ||
      (riskPattern.lifestyleGapSeverity === 'severe' && riskPattern.ageDeviationSeverity !== 'none')
    ) {
      tier = MatchType.CREATIVE;
    }
  }

  // CREATIVE → RISKY downgrades
  if (tier === MatchType.CREATIVE) {
    if (
      riskPattern.riskScore >= 6 ||
      (riskPattern.lifestyleGapSeverity === 'severe' &&
        riskPattern.ageDeviationSeverity === 'severe')
    ) {
      tier = MatchType.RISKY;
    }
  }

  return tier;
}

// ── Risk Level ────────────────────────────────────────────

function computeRiskLevel(
  matchScore: number,
  confidenceScore: number,
  _internal: MatchableInternal,
  external: MatchableExternal,
  riskPattern: RiskPattern,
): RiskLevel {
  let riskPoints = 0;

  if (confidenceScore < 40) riskPoints += 2;
  else if (confidenceScore < 60) riskPoints += 1;

  if (riskPattern.sectorCloseness < SECTOR_RISK.HIGH_RISK_THRESHOLD) riskPoints += 3;
  else if (riskPattern.sectorCloseness < SECTOR_RISK.RISK_THRESHOLD) riskPoints += 2;

  if (matchScore < 40) riskPoints += 2;
  else if (matchScore < 55) riskPoints += 1;

  if (external.staleAt) riskPoints += 1;

  // Risk pattern contributes
  if (riskPattern.riskScore >= 6) riskPoints += 2;
  else if (riskPattern.riskScore >= 4) riskPoints += 1;

  if (riskPoints >= 5) return RiskLevel.HIGH;
  if (riskPoints >= 3) return RiskLevel.MEDIUM;
  if (riskPoints >= 1) return RiskLevel.LOW;
  return RiskLevel.NONE;
}

// ── Recommended Action ────────────────────────────────────
//
// Operational semantics:
//
//   send_to_both:       Ideal match — very high confidence, safe type,
//                       no risk patterns, no overrides. Can go straight to
//                       both sides without serial gating.
//
//   send_side_a_first:  Safe match with clean signals but not "send to both"
//                       level (some minor risk, moderate confidence, or single
//                       override). Start with side A.
//
//   auto_review_queue:  Solid match (safe-with-low-risk or strong balanced)
//                       that benefits from a quick Shadchan sanity check
//                       before sending. Batched workflow — no urgent attention.
//
//   review_required:    Requires specific human judgment. Used for:
//                         - Creative / risky matches
//                         - High risk level
//                         - Balanced with low confidence
//                         - Significant override usage or risk patterns
//
//   hold_for_more_data: Can't act yet. Used when:
//                         - sendReadinessBlockers exist on internal
//                         - confidence is critically low (<30)
//                         - profile is incomplete on either side
//
//   skip:               Hard blocked (only used on ineligible pairs).

function determineAction(
  matchType: MatchType,
  riskLevel: RiskLevel,
  confidenceScore: number,
  internal: MatchableInternal,
  riskPattern: RiskPattern,
): RecommendedAction {
  // ── Blockers first ─────────────────────────────────────
  if (internal.sendReadinessBlockers.length > 0) return 'hold_for_more_data';
  if (confidenceScore < 30) return 'hold_for_more_data';

  // ── High risk always requires attention ────────────────
  if (riskLevel === RiskLevel.HIGH) return 'review_required';

  // ── Per match-type decision tree ───────────────────────
  switch (matchType) {
    case MatchType.SAFE: {
      const isIdeal =
        confidenceScore >= 85 &&
        riskLevel === RiskLevel.NONE &&
        riskPattern.riskScore === 0 &&
        riskPattern.overrideCount === 0;
      if (isIdeal) return 'send_to_both';

      const isClean =
        riskLevel === RiskLevel.NONE &&
        riskPattern.riskScore <= 2 &&
        riskPattern.overrideCount <= 1;
      if (isClean) return 'send_side_a_first';

      return 'auto_review_queue';
    }

    case MatchType.BALANCED: {
      const isStrong =
        confidenceScore >= 70 &&
        (riskLevel === RiskLevel.NONE || riskLevel === RiskLevel.LOW) &&
        riskPattern.riskScore <= 3;
      if (isStrong) return 'auto_review_queue';
      return 'review_required';
    }

    case MatchType.CREATIVE:
      return 'review_required';

    case MatchType.RISKY:
      return 'review_required';

    default:
      return 'review_required';
  }
}

// ── Send Strategy ─────────────────────────────────────────
//
// The send strategy is about ordering (side A first vs both at once).
// It follows from the recommended action — matches that warrant
// send_to_both get the simultaneous strategy.

function determineSendStrategy(
  _matchType: MatchType,
  recommendedAction: RecommendedAction,
): SendStrategy {
  if (recommendedAction === 'send_to_both') return 'both_simultaneously';
  return 'side_a_first';
}

// ── Helpers ───────────────────────────────────────────────

function findDimension(
  breakdown: DimensionScore[],
  dim: ScoringDimension,
): DimensionScore | undefined {
  return breakdown.find(d => d.dimension === dim);
}

// ── Blocked result helper ─────────────────────────────────

function makeBlockedResult(
  internal: MatchableInternal,
  external: MatchableExternal,
  blockers: BlockerReason[],
  context: MatchingContext,
): MatchResult {
  return {
    internalCandidateId: internal._id,
    externalCandidateId: external._id,
    eligible: false,
    // Legacy string form kept so existing UI code that reads
    // `hardBlockers` keeps functioning without change.
    hardBlockers: blockers.map((b) => b.message),
    blockers,
    matchScore: 0,
    rawScore: 0,
    confidenceScore: 0,
    matchType: MatchType.RISKY,
    riskLevel: RiskLevel.HIGH,
    scoreBreakdown: [],
    strengths: [],
    attentionPoints: [],
    overrideReasons: [],
    flexibilityOverrideApplied: false,
    recommendedAction: 'skip',
    sendStrategy: 'side_a_first',
    sourceMode: context.mode,
    penalties: { historyPenalty: 0, stalePenalty: 0, timingPenalty: 0, loadPenalty: 0, totalPenalty: 0 },
  };
}

// ── Utility ───────────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  return Math.floor(Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}
