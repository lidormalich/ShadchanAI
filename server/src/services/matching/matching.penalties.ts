// ═══════════════════════════════════════════════════════════
// ShadchanAI — Penalty Computation
//
// Penalties reduce the final matchScore after dimension scoring.
// They account for external factors that don't reflect
// compatibility but affect actionability.
//
// Penalties are always >= 0 and bounded by caps.
// ═══════════════════════════════════════════════════════════

import type { MatchableInternal, MatchableExternal, MatchingContext, Penalties } from './matching.types.js';
import { PENALTY } from './matching.constants.js';

/**
 * Compute all penalties for a given pair + context.
 * Each penalty is independently capped, and totalPenalty
 * is the sum (also soft-capped at 40 to prevent total wipeout).
 */
export function computePenalties(
  internal: MatchableInternal,
  external: MatchableExternal,
  context: MatchingContext,
): Penalties {
  const stalePenalty = computeStalePenalty(external);
  const historyPenalty = computeHistoryPenalty(external, context);
  const timingPenalty = computeTimingPenalty(internal, context);
  const loadPenalty = computeLoadPenalty(context);

  const totalPenalty = Math.min(40, stalePenalty + historyPenalty + timingPenalty + loadPenalty);

  return {
    stalePenalty,
    historyPenalty,
    timingPenalty,
    loadPenalty,
    totalPenalty,
  };
}

// ── Stale penalty ─────────────────────────────────────────
// External profiles that haven't been updated or confirmed
// recently get penalized — their data may be outdated.

function computeStalePenalty(external: MatchableExternal): number {
  const referenceDate = external.lastConfirmedAvailableAt
    ?? external.lastSourceUpdateAt
    ?? external.sourceImportedAt;

  const daysSince = daysBetween(referenceDate, new Date());

  if (daysSince <= PENALTY.STALE_THRESHOLD_DAYS) return 0;

  const overdueDays = daysSince - PENALTY.STALE_THRESHOLD_DAYS;
  const periods = Math.floor(overdueDays / 30);
  return Math.min(PENALTY.STALE_MAX, periods * PENALTY.STALE_RATE_PER_30_DAYS);
}

// ── History penalty ───────────────────────────────────────
//
// Three tiers, composable:
//
//   1. Direct decline: this exact pair was declined recently.
//   2. Similar-profile decline pattern (future extension hook):
//      internal has declined N candidates with a profile similar to
//      this external → pattern penalty.
//   3. External-side fatigue (future extension hook): external has
//      received many similar proposals recently.
//
// Tiers 2 and 3 fire only when the upstream pattern-analysis service
// populates `similarProfileDeclineCount` / `recentSimilarProposalCount`
// on the context. Until that service ships, those fields stay undefined
// and the corresponding penalties are zero.

function computeHistoryPenalty(
  external: MatchableExternal,
  context: MatchingContext,
): number {
  let penalty = 0;

  // ── Tier 1: Direct pair decline ──────────────────────
  const declineDate = context.recentDeclines.get(external._id);
  if (declineDate) {
    const daysSince = daysBetween(declineDate, new Date());
    if (daysSince < 90) {
      penalty += PENALTY.HISTORY_PER_DECLINE;
    }
  }

  // ── Tier 2: Similar-profile decline pattern ──────────
  if (context.similarProfileDeclineCount && context.similarProfileDeclineCount > 0) {
    const patternPenalty = Math.min(
      PENALTY.HISTORY_PATTERN_MAX,
      context.similarProfileDeclineCount * PENALTY.HISTORY_PATTERN_PER_DECLINE,
    );
    penalty += patternPenalty;
  }

  // ── Tier 3: External-side fatigue ────────────────────
  if (
    context.recentSimilarProposalCount !== undefined &&
    context.recentSimilarProposalCount > PENALTY.FATIGUE_THRESHOLD
  ) {
    const excess = context.recentSimilarProposalCount - PENALTY.FATIGUE_THRESHOLD;
    penalty += Math.min(PENALTY.FATIGUE_MAX, excess * PENALTY.FATIGUE_PER_EXTRA);
  }

  return Math.min(PENALTY.HISTORY_MAX + PENALTY.HISTORY_PATTERN_MAX + PENALTY.FATIGUE_MAX, penalty);
}

// ── Timing penalty ────────────────────────────────────────
// If the internal candidate was recently sent a suggestion,
// give them breathing room. Also applies an internal-fatigue
// component if the pattern-analysis service has populated
// recentProposalsReceivedByInternal.

function computeTimingPenalty(
  internal: MatchableInternal,
  context: MatchingContext,
): number {
  let penalty = 0;

  if (internal.lastActionAt) {
    const daysSince = daysBetween(internal.lastActionAt, new Date());
    if (daysSince < PENALTY.TIMING_THRESHOLD_DAYS) {
      penalty += PENALTY.TIMING_PENALTY;
    }
  }

  // Internal fatigue: too many proposals recently
  if (
    context.recentProposalsReceivedByInternal !== undefined &&
    context.recentProposalsReceivedByInternal > PENALTY.INTERNAL_FATIGUE_THRESHOLD
  ) {
    const excess = context.recentProposalsReceivedByInternal - PENALTY.INTERNAL_FATIGUE_THRESHOLD;
    penalty += Math.min(PENALTY.INTERNAL_FATIGUE_MAX, excess * PENALTY.INTERNAL_FATIGUE_PER_EXTRA);
  }

  return penalty;
}

// ── Load penalty ──────────────────────────────────────────
// Too many active suggestions for one candidate = lower
// priority for new ones.

function computeLoadPenalty(context: MatchingContext): number {
  if (context.activeSuggestionCount <= PENALTY.LOAD_THRESHOLD) return 0;

  const excess = context.activeSuggestionCount - PENALTY.LOAD_THRESHOLD;
  return Math.min(PENALTY.LOAD_MAX, excess * PENALTY.LOAD_PER_EXTRA);
}

// ── Utility ───────────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  return Math.floor(Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}
