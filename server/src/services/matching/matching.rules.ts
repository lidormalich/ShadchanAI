// ═══════════════════════════════════════════════════════════
// ShadchanAI — Hard Blocking Rules
//
// These rules produce a binary pass/fail. If ANY rule fires,
// the pair is ineligible and the match is blocked.
//
// CRITICAL DESIGN PRINCIPLE:
//   Sector/community is NEVER an automatic hard blocker.
//   Only explicit user-stated constraints become hard rules.
//   Everything else goes into soft scoring.
//
// Each rule returns either null (pass) or a human-readable
// blocker string (fail).
// ═══════════════════════════════════════════════════════════

import { CandidateStatus, ExternalCandidateStatus, AvailabilityStatus } from '@shadchanai/shared';
import type { MatchableInternal, MatchableExternal, MatchingContext, HardConstraint } from './matching.types.js';
import { DECLINE_COOLDOWN_DAYS } from './matching.constants.js';

/** Result of running all hard rules against a pair */
export interface HardRuleResult {
  eligible: boolean;
  blockers: string[];
}

/**
 * Run all hard rules. Returns early on first blocker for efficiency,
 * but collects ALL blockers for reporting.
 */
export function evaluateHardRules(
  internal: MatchableInternal,
  external: MatchableExternal,
  context: MatchingContext,
): HardRuleResult {
  const blockers: string[] = [];

  for (const rule of HARD_RULES) {
    const result = rule(internal, external, context);
    if (result) blockers.push(result);
  }

  return {
    eligible: blockers.length === 0,
    blockers,
  };
}

// ── Individual rule functions ─────────────────────────────

type HardRule = (
  internal: MatchableInternal,
  external: MatchableExternal,
  context: MatchingContext,
) => string | null;

/** Gender must be opposite */
function genderRule(internal: MatchableInternal, external: MatchableExternal): string | null {
  if (!external.gender) return null; // missing data → not blocked, but confidence drops
  if (internal.gender === external.gender) {
    return `Same gender (${internal.gender})`;
  }
  return null;
}

/** Internal candidate must be in a matchable status */
function internalStatusRule(internal: MatchableInternal): string | null {
  const matchable: string[] = [CandidateStatus.ACTIVE];
  if (!matchable.includes(internal.status)) {
    return `Internal candidate status is '${internal.status}'`;
  }
  return null;
}

/** External candidate must be available */
function externalStatusRule(_i: MatchableInternal, external: MatchableExternal): string | null {
  if (external.status !== ExternalCandidateStatus.ACTIVE) {
    return `External candidate status is '${external.status}'`;
  }
  if (external.availabilityStatus === AvailabilityStatus.UNAVAILABLE) {
    return 'External candidate is marked unavailable';
  }
  if (external.availabilityStatus === AvailabilityStatus.DATING) {
    return 'External candidate is currently dating';
  }
  return null;
}

/** Internal candidate already dating someone */
function alreadyDatingRule(internal: MatchableInternal): string | null {
  if (internal.datingPartnerCandidateId) {
    return 'Internal candidate is already in an active dating relationship';
  }
  return null;
}

/** Same pair already has an active suggestion */
function activePairRule(
  _i: MatchableInternal,
  external: MatchableExternal,
  context: MatchingContext,
): string | null {
  if (context.activeMatchExternalIds.has(external._id)) {
    return 'An active suggestion already exists for this pair';
  }
  return null;
}

/** Same pair was recently declined — cooldown period */
function declineCooldownRule(
  _i: MatchableInternal,
  external: MatchableExternal,
  context: MatchingContext,
): string | null {
  const declineDate = context.recentDeclines.get(external._id);
  if (!declineDate) return null;

  const daysSinceDecline = daysBetween(declineDate, new Date());
  if (daysSinceDecline < DECLINE_COOLDOWN_DAYS) {
    return `Pair was declined ${daysSinceDecline} days ago (cooldown: ${DECLINE_COOLDOWN_DAYS} days)`;
  }
  return null;
}

/**
 * Explicit hard constraints — evaluated BIDIRECTIONALLY.
 *
 *   - Internal's constraints checked against external's fields
 *     ("internal says: no candidates where X")
 *   - External's constraints (when present) checked against
 *     internal's fields ("external says: no candidates where Y")
 *
 * Either side's explicit blocker makes the pair ineligible.
 */
function explicitConstraintsRule(
  internal: MatchableInternal,
  external: MatchableExternal,
): string | null {
  // Forward direction: internal's constraints vs external's fields
  for (const constraint of internal.hardConstraints) {
    if (evaluateConstraint(constraint, getSubjectFields(external))) {
      return `Internal hard constraint violated: ${constraint.field} ${constraint.operator} ${JSON.stringify(constraint.value)}${constraint.reason ? ` (${constraint.reason})` : ''}`;
    }
  }
  // Reverse direction: external's constraints (if any) vs internal's fields
  for (const constraint of external.hardConstraints ?? []) {
    if (evaluateConstraint(constraint, getSubjectFields(internal))) {
      return `External hard constraint violated: ${constraint.field} ${constraint.operator} ${JSON.stringify(constraint.value)}${constraint.reason ? ` (${constraint.reason})` : ''}`;
    }
  }
  return null;
}

/**
 * Reverse personal-status compatibility: when external has explicit
 * openness flags / constraints, evaluate them against internal's status.
 *
 * External-side data is optional, so this only fires when external
 * actually carries the preferences.
 */
function personalStatusCompatibilityRuleReverse(
  internal: MatchableInternal,
  external: MatchableExternal,
): string | null {
  if (!internal.personalStatus || !external.openness) return null;

  const status = internal.personalStatus;
  const isDivorcedOrSeparated = status === 'divorced' || status === 'separated';

  if (isDivorcedOrSeparated && external.openness.openToDivorced === false) {
    return `External candidate explicitly not open to ${status} candidates`;
  }
  return null;
}

/**
 * Personal-status compatibility rule.
 *
 * Generalized handling for single / divorced / separated / widowed:
 *
 *   - Divorced or separated external + internal not openToDivorced → BLOCK
 *   - Widowed external → allowed unless an explicit constraint exists
 *   - Second-chapter external (any non-single status) + internal not
 *     openToWithChildren + internal has an explicit children-related
 *     hardConstraint → BLOCK (children inference is only applied when
 *     the constraint is explicit — we don't hard-block on inference alone)
 *
 * Note: general openness flags (openToDivorced, openToWithChildren, etc.)
 * are part of the candidate's requirements. Any additional nuance comes
 * through the explicitConstraintsRule which runs separately.
 */
function personalStatusCompatibilityRule(
  internal: MatchableInternal,
  external: MatchableExternal,
): string | null {
  if (!external.personalStatus) return null;

  const status = external.personalStatus;
  const isDivorcedOrSeparated = status === 'divorced' || status === 'separated';
  const isWidowed = status === 'widowed';
  const isSecondChapter = isDivorcedOrSeparated || isWidowed;

  // ── Divorced / separated: standard openness check ───────
  if (isDivorcedOrSeparated && !internal.openness.openToDivorced) {
    return `Internal candidate not open to ${status} candidates`;
  }

  // ── Widowed: more lenient, block only on explicit constraint ──
  if (isWidowed && hasExplicitStatusBlocker(internal, 'widowed')) {
    return 'Internal candidate has explicit hard constraint against widowed candidates';
  }

  // ── Children-related explicit blocker ──────────────────
  // Second-chapter candidates commonly have children. If the internal
  // has an explicit hard constraint against candidates with children,
  // block the suggestion. Inference alone (without explicit constraint)
  // is NOT a hard block — it becomes a soft score / attention point.
  if (isSecondChapter && !internal.openness.openToWithChildren && hasExplicitChildrenBlocker(internal)) {
    return `Internal candidate explicitly not open to candidates with children (${status} profile flagged)`;
  }

  return null;
}

function hasExplicitStatusBlocker(
  internal: MatchableInternal,
  status: string,
): boolean {
  return internal.hardConstraints.some((c) => {
    if (c.field !== 'personalStatus') return false;
    if (c.operator === 'eq' && c.value === status) return true;
    if (c.operator === 'not_in' && Array.isArray(c.value) && !(c.value as unknown[]).includes(status)) return true;
    return false;
  });
}

function hasExplicitChildrenBlocker(internal: MatchableInternal): boolean {
  return internal.hardConstraints.some((c) => {
    if (c.field === 'hasChildren' && c.operator === 'eq' && c.value === true) return true;
    if (
      c.field === 'numberOfChildren' &&
      (c.operator === 'gt' || c.operator === 'gte') &&
      typeof c.value === 'number' &&
      c.value >= 0
    ) {
      return true;
    }
    return false;
  });
}

// ── Constraint evaluation ─────────────────────────────────

/** Extract fields a constraint can reference from either side. */
function getSubjectFields(subject: MatchableInternal | MatchableExternal): Record<string, unknown> {
  // Works for both types because these fields exist on both
  const s = subject as MatchableInternal & MatchableExternal;
  const fields: Record<string, unknown> = {
    gender: s.gender,
    city: s.city,
    sectorGroup: s.sectorGroup,
    subSector: s.subSector,
    lifestyleTone: s.lifestyleTone,
    personalStatus: s.personalStatus,
    lifeStage: s.lifeStage,
    studyWorkDirection: s.studyWorkDirection,
    height: s.height,
  };
  // Age: external has `age`, internal derives from dateOfBirth
  if ('age' in s && typeof s.age === 'number') {
    fields['age'] = s.age;
  } else if ('dateOfBirth' in s && s.dateOfBirth instanceof Date) {
    fields['age'] = ageFromDob(s.dateOfBirth);
  }
  // Internal-only fields
  if ('numberOfChildren' in s) {
    fields['numberOfChildren'] = s.numberOfChildren;
    fields['hasChildren'] = (s.numberOfChildren ?? 0) > 0;
  }
  if ('availabilityStatus' in s) {
    fields['availabilityStatus'] = s.availabilityStatus;
  }
  return fields;
}

function ageFromDob(dob: Date): number {
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

function evaluateConstraint(
  constraint: HardConstraint,
  subjectFields: Record<string, unknown>,
): boolean {
  const subjectValue = subjectFields[constraint.field];
  if (subjectValue === undefined || subjectValue === null) return false;

  switch (constraint.operator) {
    case 'eq':
      return subjectValue === constraint.value;
    case 'neq':
      return subjectValue !== constraint.value;
    case 'in':
      return Array.isArray(constraint.value) && (constraint.value as unknown[]).includes(subjectValue);
    case 'not_in':
      return Array.isArray(constraint.value) && !(constraint.value as unknown[]).includes(subjectValue);
    case 'gt':
      return typeof subjectValue === 'number' && typeof constraint.value === 'number' && subjectValue > constraint.value;
    case 'lt':
      return typeof subjectValue === 'number' && typeof constraint.value === 'number' && subjectValue < constraint.value;
    case 'gte':
      return typeof subjectValue === 'number' && typeof constraint.value === 'number' && subjectValue >= constraint.value;
    case 'lte':
      return typeof subjectValue === 'number' && typeof constraint.value === 'number' && subjectValue <= constraint.value;
    case 'between': {
      if (typeof subjectValue !== 'number') return false;
      const [min, max] = constraint.value as [number, number];
      return subjectValue < min || subjectValue > max;
    }
    default:
      return false;
  }
}

// ── Utilities ─────────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  return Math.floor(Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

// ── Rule registry ─────────────────────────────────────────
// Order matters for readability of blocker lists, not logic.

const HARD_RULES: HardRule[] = [
  genderRule,
  internalStatusRule,
  externalStatusRule,
  alreadyDatingRule,
  activePairRule,
  declineCooldownRule,
  personalStatusCompatibilityRule,
  personalStatusCompatibilityRuleReverse,
  explicitConstraintsRule,
];
