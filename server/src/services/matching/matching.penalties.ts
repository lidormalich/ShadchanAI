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
  const statusPenalty = computeStatusPenalty(internal, external);

  const totalPenalty = Math.min(
    40,
    stalePenalty + historyPenalty + timingPenalty + loadPenalty + statusPenalty,
  );

  return {
    stalePenalty,
    historyPenalty,
    timingPenalty,
    loadPenalty,
    statusPenalty,
    totalPenalty,
  };
}

// ── Personal-status penalty ───────────────────────────────
//
// A soft priority adjustment, NOT a compatibility block. When exactly ONE
// side is "second chapter" (divorced / separated / widowed) and the other is
// single, the pair stays eligible but its score drops so it sinks toward the
// bottom of the list — a single candidate is shown singles first, with
// second-chapter matches ranked low. Symmetric across gender and direction.
//
// No penalty when:
//   - both sides are single, or
//   - both sides are second-chapter (a divorcee matched with a divorcee), or
//   - the single side is EXPLICITLY open to divorced (openToDivorced === true).
//
// Note: openToDivorced defaults to false in the DB, so this rule keys off
// personalStatus (reliable) and treats only an explicit `true` as "open" —
// a false/undefined flag never turns a single↔second-chapter pair into a
// full-score match, but it never hides it either.

const SECOND_CHAPTER_STATUSES = ['divorced', 'separated', 'widowed'];

function computeStatusPenalty(
  internal: MatchableInternal,
  external: MatchableExternal,
): number {
  if (!external.personalStatus) return 0;

  const internalSecond = SECOND_CHAPTER_STATUSES.includes(internal.personalStatus);
  const externalSecond = SECOND_CHAPTER_STATUSES.includes(external.personalStatus);

  // Aligned chapters (single↔single or second↔second) → no penalty.
  if (internalSecond === externalSecond) return 0;

  // Exactly one side is second-chapter → the OTHER side is single. Waive the
  // penalty only when that single side explicitly opted in to divorced.
  const singleSideExplicitlyOpen = internalSecond
    ? external.openness?.openToDivorced === true
    : internal.openness.openToDivorced === true;
  if (singleSideExplicitlyOpen) return 0;

  return PENALTY.STATUS_MISMATCH;
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
