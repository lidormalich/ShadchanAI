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

import {
  CandidateStatus,
  ExternalCandidateStatus,
  AvailabilityStatus,
  BlockerCode,
  BlockerSeverity,
  BlockerOverridable,
} from '@shadchanai/shared';
import type {
  MatchableInternal,
  MatchableExternal,
  MatchingContext,
  HardConstraint,
  BlockerReason,
} from './matching.types.js';
import { DECLINE_COOLDOWN_DAYS } from './matching.constants.js';

/** Result of running all hard rules against a pair */
export interface HardRuleResult {
  eligible: boolean;
  blockers: BlockerReason[];
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
  const blockers: BlockerReason[] = [];

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
) => BlockerReason | null;

function block(
  code: BlockerCode,
  severity: BlockerSeverity,
  overridable: BlockerOverridable,
  message: string,
  detail?: Record<string, unknown>,
): BlockerReason {
  return { code, severity, overridable, message, detail };
}

// Hebrew labels for enum values embedded in blocker messages, so the
// operator-facing text stays fully in Hebrew (blocker.message is rendered
// verbatim across the match screens). Unknown values fall back to raw.
const GENDER_HE: Record<string, string> = { male: 'גבר', female: 'אישה' };
const PERSONAL_STATUS_HE: Record<string, string> = {
  single: 'רווק/ה', divorced: 'גרוש/ה', widowed: 'אלמן/ה', separated: 'פרוד/ה',
};
const CANDIDATE_STATUS_HE: Record<string, string> = {
  active: 'פעיל', paused: 'בהשהיה', dating: 'בהיכרות', closed: 'סגור', archived: 'בארכיון',
};
const he = (map: Record<string, string>, v: string | undefined): string => (v ? map[v] ?? v : '');

/** Gender must be opposite — ethical/biological, never overridable. */
function genderRule(internal: MatchableInternal, external: MatchableExternal): BlockerReason | null {
  if (!external.gender) return null;
  if (internal.gender === external.gender) {
    return block(
      BlockerCode.SAME_GENDER,
      BlockerSeverity.HARD_NON_OVERRIDABLE,
      BlockerOverridable.NONE,
      `שני הצדדים מאותו מין (${he(GENDER_HE, internal.gender)})`,
    );
  }
  return null;
}

/** Internal candidate must be in a matchable status. Not overridable —
 *  the candidate themselves has been paused/closed/archived. */
function internalStatusRule(internal: MatchableInternal): BlockerReason | null {
  const matchable: string[] = [CandidateStatus.ACTIVE];
  if (!matchable.includes(internal.status)) {
    return block(
      BlockerCode.INTERNAL_NOT_ACTIVE,
      BlockerSeverity.HARD_NON_OVERRIDABLE,
      BlockerOverridable.NONE,
      `המועמד הפנימי אינו פעיל (סטטוס: ${he(CANDIDATE_STATUS_HE, internal.status)})`,
      { status: internal.status },
    );
  }
  return null;
}

/** External candidate must be available. Archival / dating are never
 *  overridable (ethical: they've withdrawn or are dating someone else). */
function externalStatusRule(_i: MatchableInternal, external: MatchableExternal): BlockerReason | null {
  if (external.status !== ExternalCandidateStatus.ACTIVE) {
    return block(
      BlockerCode.EXTERNAL_NOT_ACTIVE,
      BlockerSeverity.HARD_NON_OVERRIDABLE,
      BlockerOverridable.NONE,
      `המועמד החיצוני אינו פעיל (סטטוס: ${he(CANDIDATE_STATUS_HE, external.status)})`,
      { status: external.status },
    );
  }
  if (external.availabilityStatus === AvailabilityStatus.UNAVAILABLE) {
    return block(
      BlockerCode.EXTERNAL_UNAVAILABLE,
      BlockerSeverity.HARD_NON_OVERRIDABLE,
      BlockerOverridable.NONE,
      'המועמד החיצוני מסומן כלא זמין',
    );
  }
  if (external.availabilityStatus === AvailabilityStatus.DATING) {
    return block(
      BlockerCode.EXTERNAL_DATING,
      BlockerSeverity.HARD_NON_OVERRIDABLE,
      BlockerOverridable.NONE,
      'המועמד החיצוני נמצא כעת בהיכרות',
    );
  }
  return null;
}

/** Internal already in a relationship. Ethical lock. */
function alreadyDatingRule(internal: MatchableInternal): BlockerReason | null {
  if (internal.datingPartnerCandidateId) {
    return block(
      BlockerCode.INTERNAL_ALREADY_DATING,
      BlockerSeverity.HARD_NON_OVERRIDABLE,
      BlockerOverridable.NONE,
      'המועמד הפנימי כבר נמצא בקשר היכרות פעיל',
    );
  }
  return null;
}

/** Duplicate active suggestion. Overridable with reason (e.g. stale
 *  state cleanup) but prompts a justification. */
function activePairRule(
  _i: MatchableInternal,
  external: MatchableExternal,
  context: MatchingContext,
): BlockerReason | null {
  if (context.activeMatchExternalIds.has(external._id)) {
    return block(
      BlockerCode.ACTIVE_PAIR_DUPLICATE,
      BlockerSeverity.HARD_OVERRIDABLE,
      BlockerOverridable.WITH_REASON,
      'כבר קיימת הצעה פעילה לזוג הזה',
    );
  }
  return null;
}

/** Recent decline cooldown. Overridable when operator has new info. */
function declineCooldownRule(
  _i: MatchableInternal,
  external: MatchableExternal,
  context: MatchingContext,
): BlockerReason | null {
  const declineDate = context.recentDeclines.get(external._id);
  if (!declineDate) return null;

  const daysSinceDecline = daysBetween(declineDate, new Date());
  if (daysSinceDecline < DECLINE_COOLDOWN_DAYS) {
    return block(
      BlockerCode.RECENT_DECLINE_COOLDOWN,
      BlockerSeverity.HARD_OVERRIDABLE,
      BlockerOverridable.WITH_REASON,
      `הזוג נדחה לפני ${daysSinceDecline} ימים (תקופת צינון: ${DECLINE_COOLDOWN_DAYS} ימים)`,
      { daysSinceDecline, cooldownDays: DECLINE_COOLDOWN_DAYS },
    );
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
): BlockerReason | null {
  // Forward direction: internal's constraints vs external's fields.
  // Overridable with reason — an operator may know something the form didn't capture.
  for (const constraint of internal.hardConstraints) {
    if (evaluateConstraint(constraint, getSubjectFields(external))) {
      return block(
        BlockerCode.EXPLICIT_HARD_CONSTRAINT,
        BlockerSeverity.HARD_OVERRIDABLE,
        BlockerOverridable.WITH_REASON,
        `הופר אילוץ קשיח של הצד הפנימי: ${constraint.field} ${constraint.operator} ${JSON.stringify(constraint.value)}${constraint.reason ? ` (${constraint.reason})` : ''}`,
        { side: 'internal', field: constraint.field, operator: constraint.operator, value: constraint.value },
      );
    }
  }
  // Reverse direction: external's own stated constraints. These are
  // the candidate's own filter — NEVER overridable.
  for (const constraint of external.hardConstraints ?? []) {
    if (evaluateConstraint(constraint, getSubjectFields(internal))) {
      return block(
        BlockerCode.EXPLICIT_HARD_CONSTRAINT,
        BlockerSeverity.HARD_NON_OVERRIDABLE,
        BlockerOverridable.NONE,
        `הופר אילוץ קשיח של הצד החיצוני: ${constraint.field} ${constraint.operator} ${JSON.stringify(constraint.value)}${constraint.reason ? ` (${constraint.reason})` : ''}`,
        { side: 'external', field: constraint.field, operator: constraint.operator, value: constraint.value },
      );
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
): BlockerReason | null {
  if (!internal.personalStatus || !external.openness) return null;

  const status = internal.personalStatus;
  const isDivorcedOrSeparated = status === 'divorced' || status === 'separated';

  if (isDivorcedOrSeparated && external.openness.openToDivorced === false) {
    // External stated their own openness — not overridable.
    return block(
      BlockerCode.EXTERNAL_NOT_OPEN_TO_STATUS,
      BlockerSeverity.HARD_NON_OVERRIDABLE,
      BlockerOverridable.NONE,
      `המועמד החיצוני ציין במפורש שאינו פתוח למועמדים בסטטוס ${he(PERSONAL_STATUS_HE, status)}`,
      { status },
    );
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
): BlockerReason | null {
  if (!external.personalStatus) return null;

  const status = external.personalStatus;
  const isDivorcedOrSeparated = status === 'divorced' || status === 'separated';
  const isWidowed = status === 'widowed';
  const isSecondChapter = isDivorcedOrSeparated || isWidowed;

  // ── Divorced / separated: internal-side openness ──────
  // Overridable with reason — reflects the internal's stated preference
  // which may have evolved since onboarding.
  if (isDivorcedOrSeparated && !internal.openness.openToDivorced) {
    return block(
      BlockerCode.PERSONAL_STATUS_DIVORCED,
      BlockerSeverity.HARD_OVERRIDABLE,
      BlockerOverridable.WITH_REASON,
      `המועמד הפנימי אינו פתוח למועמדים בסטטוס ${he(PERSONAL_STATUS_HE, status)}`,
      { status },
    );
  }

  // ── Widowed + explicit internal constraint ────────────
  if (isWidowed && hasExplicitStatusBlocker(internal, 'widowed')) {
    return block(
      BlockerCode.PERSONAL_STATUS_WIDOWED,
      BlockerSeverity.HARD_OVERRIDABLE,
      BlockerOverridable.WITH_REASON,
      'למועמד הפנימי אילוץ קשיח מפורש נגד מועמדים אלמנים',
    );
  }

  // ── Children-related explicit blocker ──────────────────
  if (isSecondChapter && !internal.openness.openToWithChildren && hasExplicitChildrenBlocker(internal)) {
    return block(
      BlockerCode.CHILDREN_CONSTRAINT,
      BlockerSeverity.HARD_OVERRIDABLE,
      BlockerOverridable.WITH_REASON,
      `המועמד הפנימי אינו פתוח למועמדים עם ילדים (סומן פרופיל ${he(PERSONAL_STATUS_HE, status)})`,
      { externalStatus: status },
    );
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
