// ═══════════════════════════════════════════════════════════
// ShadchanAI — 8-Dimension Soft Scoring
//
// Each dimension produces a score from 0–100. The final
// matchScore is the weighted sum.
//
// Dimensions:
//   1. Age — proximity with gender-direction awareness
//   2. Sector / sub-sector — closeness-matrix based
//   3. Lifestyle / home style — tone closeness
//   4. Study-work direction — direction closeness
//   5. Location — same city / region / relocate
//   6. Mutual expectations — soft-preference alignment
//   7. Life stage / maturity — stage closeness
//   8. Flexibility / creative override — Shadchan boost
//
// Every function is pure: same inputs → same outputs.
// No DB calls, no AI, no side effects.
// ═══════════════════════════════════════════════════════════

import { ScoringDimension } from '@shadchanai/shared';
import type {
  MatchableInternal,
  MatchableExternal,
  MatchingContext,
  DimensionScore,
  MatchingWeights,
} from './matching.types.js';
import {
  combinedSectorCloseness,
  lifestyleCloseness,
  lifeStageCloseness,
  studyWorkCloseness,
  regionCloseness,
  childrenPreferenceCloseness,
  careerPriorityCloseness,
} from './matching.matrix.js';
import type { AgeBandConfig } from './matching.constants.js';
import {
  DEFAULT_WEIGHTS,
  AGE,
  DEFAULT_AGE_BANDS,
  SECOND_CHAPTER_AGE_BANDS,
  MATURE_AGE_BANDS,
  YOUNG_AGE_BANDS,
  LOCATION,
  OVERRIDE,
} from './matching.constants.js';

// ── Public API ────────────────────────────────────────────

export interface ScoreResult {
  rawScore: number;
  breakdown: DimensionScore[];
  strengths: string[];
  attentionPoints: string[];
  overrideReasons: string[];
  flexibilityOverrideApplied: boolean;
  /**
   * True when either side's stated age preference is violated beyond the
   * ±tolerance. This is a SOFT flag — the pair still surfaces (a Shadchan
   * may want it anyway) — but the UI marks it as an out-of-range exception.
   */
  ageOutOfRange: boolean;
}

/**
 * Score a pair across all 8 dimensions.
 * Returns raw score (before penalties), breakdown, and analysis.
 */
export function scorePair(
  internal: MatchableInternal,
  external: MatchableExternal,
  context: MatchingContext,
  weights: MatchingWeights = DEFAULT_WEIGHTS,
): ScoreResult {
  const isSecondChapter = isSecondChapterCase(internal, external);
  const isDiscovery = context.mode === 'discovery';

  const dimensions: DimensionScore[] = [
    scoreAge(internal, external, isSecondChapter, isDiscovery),
    scoreSector(internal, external, isSecondChapter),
    scoreLifestyle(internal, external),
    scoreStudyWork(internal, external),
    scoreLocation(internal, external),
    scoreMutualExpectations(internal, external),
    scoreLifeStage(internal, external),
    scoreFlexibility(internal, external, context),
  ];

  // Apply weights
  for (const dim of dimensions) {
    const w = weights[dim.dimension as keyof MatchingWeights] ?? 0.1;
    dim.weight = w;
    dim.weightedScore = Math.round(dim.score * w * 100) / 100;
  }

  const rawScore = Math.round(dimensions.reduce((sum, d) => sum + d.weightedScore, 0));

  // Collect strengths (score >= 75) and attention points (score <= 40).
  // Location and life-stage are NEVER surfaced as "gaps"/reasons (operator
  // rule): nearby cities / different community character and life-stage /
  // education differences must not read as a concern. They still affect the
  // numeric score and can appear as a strength when strong.
  const strengths: string[] = [];
  const attentionPoints: string[] = [];
  for (const dim of dimensions) {
    if (dim.score >= 75) strengths.push(dim.detail);
    const suppressedAsGap =
      dim.dimension === ScoringDimension.LOCATION
      || dim.dimension === ScoringDimension.LIFE_STAGE;
    if (dim.score <= 40 && dim.weight > 0 && !suppressedAsGap) attentionPoints.push(dim.detail);
  }

  // Collect override reasons
  const overrideReasons: string[] = [];
  let flexibilityOverrideApplied = false;
  if (isSecondChapter) {
    overrideReasons.push('פרק ב׳: הוחל ניקוד מקל לגיל ולמגזר');
  }
  if (isDiscovery) {
    const ageScore = dimensions.find(d => d.dimension === ScoringDimension.AGE);
    if (ageScore && ageScore.score > 0 && ageScore.score < 50) {
      overrideReasons.push('מצב גילוי: נשקל טווח גילאים מורחב');
    }
  }
  // Check if flexibility dimension was actively boosted
  const flexDim = dimensions.find(d => d.dimension === ScoringDimension.FLEXIBILITY);
  if (flexDim && flexDim.score > 50) {
    flexibilityOverrideApplied = true;
  }

  return {
    rawScore: Math.max(0, Math.min(100, rawScore)),
    breakdown: dimensions,
    strengths,
    attentionPoints,
    overrideReasons,
    flexibilityOverrideApplied,
    ageOutOfRange: pairAgeOutOfRange(internal, external),
  };
}

// ── Dimension 1: Age ──────────────────────────────────────

/**
 * Select the appropriate age-band configuration for a pair.
 * Exported so pattern/analytics tools can inspect the active band.
 */
export function selectAgeBands(
  internal: MatchableInternal,
  isSecondChapter: boolean,
  isDiscovery: boolean,
): AgeBandConfig {
  let bands: AgeBandConfig;

  if (isSecondChapter) {
    bands = { ...SECOND_CHAPTER_AGE_BANDS };
  } else if (
    internal.lifeStage === 'mature' ||
    internal.lifeStage === 'established_career'
  ) {
    bands = { ...MATURE_AGE_BANDS };
  } else if (
    internal.lifeStage === 'post_high_school' ||
    internal.lifeStage === 'national_service' ||
    internal.lifeStage === 'army'
  ) {
    bands = { ...YOUNG_AGE_BANDS };
  } else {
    bands = { ...DEFAULT_AGE_BANDS };
  }

  if (isDiscovery) {
    bands.flexible += AGE.DISCOVERY_FLEXIBLE_BONUS;
    bands.outer += AGE.DISCOVERY_OUTER_BONUS;
    bands.hard += AGE.DISCOVERY_OUTER_BONUS;
  }

  return bands;
}

function scoreAge(
  internal: MatchableInternal,
  external: MatchableExternal,
  isSecondChapter: boolean,
  isDiscovery: boolean,
): DimensionScore {
  if (!external.age) {
    // Missing age is a genuine gap, not a neutral: a sparse profile should
    // not score mid-range on age just because we can't compare it.
    return makeDimension(ScoringDimension.AGE, 40, 'גיל המועמד החיצוני אינו ידוע — נתון חסר');
  }

  const internalAge = ageFromDob(internal.dateOfBirth);
  const gap = Math.abs(internalAge - external.age);
  const bands = selectAgeBands(internal, isSecondChapter, isDiscovery);

  // ── Four-band smooth decay: 100 → 70 → 30 → 0 ──────────
  let score: number;
  if (gap <= bands.preferred) {
    score = 100;
  } else if (gap <= bands.flexible) {
    const t = (gap - bands.preferred) / (bands.flexible - bands.preferred);
    score = 100 - t * 30;
  } else if (gap <= bands.outer) {
    const t = (gap - bands.flexible) / (bands.outer - bands.flexible);
    score = 70 - t * 40;
  } else if (gap <= bands.hard) {
    const t = (gap - bands.outer) / (bands.hard - bands.outer);
    score = 30 - t * 30;
  } else {
    score = 0;
  }

  // ── Gender-direction bonus (male typically same age or older) ──
  if (internal.gender === 'male' && internalAge >= external.age && gap <= 4) {
    score = Math.min(100, score + AGE.MALE_OLDER_BONUS);
  } else if (internal.gender === 'female' && external.age >= internalAge && gap <= 4) {
    score = Math.min(100, score + AGE.MALE_OLDER_BONUS);
  }

  // ── Age-preference overlay (BIDIRECTIONAL, soft, not a hard block) ──
  // Check both sides' preferences when known. Either side violated
  // applies the penalty (stacked deductions cap at total score floor).
  const internalViolated = violatesAgePref(internal.agePreferences, external.age);
  const externalViolated = external.agePreferences !== undefined
    && violatesAgePref(external.agePreferences, internalAge);
  if (internalViolated) score = Math.max(0, score - AGE.PREFERENCE_VIOLATION_PENALTY);
  if (externalViolated) score = Math.max(0, score - AGE.PREFERENCE_VIOLATION_PENALTY);

  score = Math.round(Math.max(0, Math.min(100, score)));

  const bandLabel =
    gap <= bands.preferred ? 'מועדף'
    : gap <= bands.flexible ? 'גמיש'
    : gap <= bands.outer ? 'רחב'
    : gap <= bands.hard ? 'גבולי'
    : 'מעבר לטווח';

  const detail = `פער גיל: ${gap} שנים (טווח ${bandLabel}; פנימי ${internalAge}, חיצוני ${external.age})${isSecondChapter ? ' [פרק ב׳]' : ''}`;

  return makeDimension(ScoringDimension.AGE, score, detail);
}

// ── Dimension 2: Sector / Sub-sector ──────────────────────

function scoreSector(
  internal: MatchableInternal,
  external: MatchableExternal,
  isSecondChapter: boolean,
): DimensionScore {
  let closeness = combinedSectorCloseness(
    internal.sectorGroup,
    internal.subSector,
    external.sectorGroup,
    external.subSector,
  );

  // Second-chapter bonus
  if (isSecondChapter) {
    closeness = Math.min(1.0, closeness + OVERRIDE.SECOND_CHAPTER_SECTOR_CLOSENESS_BONUS);
  }

  // Openness bonus: if EITHER side is explicitly open to other sectors,
  // boost low closeness (bidirectional)
  const eitherOpen = internal.openness.openToOtherSectors
    || external.openness?.openToOtherSectors === true;
  if (eitherOpen && closeness < 0.5) {
    closeness = Math.min(1.0, closeness + 0.15);
  }

  const score = Math.round(closeness * 100);
  const detail = `קרבת מגזר: ${(closeness * 100).toFixed(0)}%`;

  return makeDimension(ScoringDimension.SECTOR, score, detail);
}

// ── Dimension 3: Lifestyle / Home style ───────────────────

function scoreLifestyle(
  internal: MatchableInternal,
  external: MatchableExternal,
): DimensionScore {
  const closeness = lifestyleCloseness(internal.lifestyleTone, external.lifestyleTone);
  const score = Math.round(closeness * 100);
  const detail = `קרבת אורח חיים: ${score}%`;

  return makeDimension(ScoringDimension.LIFESTYLE, score, detail);
}

// ── Dimension 4: Study-work direction ─────────────────────

function scoreStudyWork(
  internal: MatchableInternal,
  external: MatchableExternal,
): DimensionScore {
  const closeness = studyWorkCloseness(internal.studyWorkDirection, external.studyWorkDirection);
  const score = Math.round(closeness * 100);
  const detail = `קרבת כיוון לימודים/עבודה: ${score}%`;

  return makeDimension(ScoringDimension.STUDY_WORK, score, detail);
}

// ── Dimension 5: Location ─────────────────────────────────

function scoreLocation(
  internal: MatchableInternal,
  external: MatchableExternal,
): DimensionScore {
  const internalCity = internal.city?.toLowerCase().trim();
  const externalCity = external.city?.toLowerCase().trim();

  // Same city always wins — exact-string identity is unambiguous.
  if (internalCity && externalCity && internalCity === externalCity) {
    return makeDimension(ScoringDimension.LOCATION, LOCATION.SAME_CITY_SCORE,
      `אותה עיר: ${internal.city}`);
  }

  // ── PRIMARY signal: region ──────────────────────────────
  // City is a brittle exact match; region is a robust, commute-aware
  // bucket. When both sides have a region we score off the region
  // closeness matrix. Region distance NEVER disqualifies (location is
  // a soft dimension) — willingness to relocate / openness lifts a
  // floor so a far pair is dampened, not killed.
  const regionClose = regionCloseness(internal.region, external.region);
  if (regionClose !== undefined) {
    let score = Math.round(regionClose * 100);
    const eitherFlexible = Boolean(
      internal.locationPreferences?.willingToRelocate
      || external.locationPreferences?.willingToRelocate
      || internal.openness.openToLongDistance
      || external.openness?.openToLongDistance === true,
    );
    if (eitherFlexible) score = Math.max(score, LOCATION.RELOCATE_FLOOR);
    const detail = internal.region === external.region
      ? `אותו אזור`
      : `קרבת אזור: ${Math.round(regionClose * 100)}%${eitherFlexible ? ' — גמישות במרחק' : ''}`;
    return makeDimension(ScoringDimension.LOCATION, score, detail);
  }

  // ── Fallback: no region on at least one side → city logic ──
  if (!internalCity || !externalCity) {
    return makeDimension(ScoringDimension.LOCATION, LOCATION.MISSING_DATA_SCORE,
      'נתוני מיקום חלקיים — ציון ניטרלי');
  }

  // BIDIRECTIONAL: check each side's city against the OTHER side's preferred cities
  const internalPreferredCities = internal.locationPreferences?.cities?.map((c) => c.toLowerCase().trim()) ?? [];
  const externalPreferredCities = external.locationPreferences?.cities?.map((c) => c.toLowerCase().trim()) ?? [];
  const externalCityInInternalPrefs = internalPreferredCities.includes(externalCity);
  const internalCityInExternalPrefs = externalPreferredCities.includes(internalCity);
  if (externalCityInInternalPrefs || internalCityInExternalPrefs) {
    return makeDimension(ScoringDimension.LOCATION, 90,
      `הערים תואמות להעדפות אחד הצדדים (${internal.city} ↔ ${external.city})`);
  }

  // Region hint on either side
  const anyRegionHint = (internal.locationPreferences?.regions?.length ?? 0) > 0
    || (external.locationPreferences?.regions?.length ?? 0) > 0;
  if (anyRegionHint) {
    return makeDimension(ScoringDimension.LOCATION, LOCATION.SAME_REGION_SCORE,
      `ערים שונות אך צוינו העדפות אזור`);
  }

  // Either side willing to relocate / open to long distance (BIDIRECTIONAL)
  const eitherWillingToRelocate = Boolean(
    internal.locationPreferences?.willingToRelocate || external.locationPreferences?.willingToRelocate,
  );
  if (eitherWillingToRelocate) {
    return makeDimension(ScoringDimension.LOCATION, LOCATION.DIFFERENT_REGION_RELOCATE_WILLING,
      `ערים שונות (${internal.city} ↔ ${external.city}) — צד אחד לפחות מוכן לעבור דירה`);
  }

  const eitherOpenToDistance = internal.openness.openToLongDistance
    || external.openness?.openToLongDistance === true;
  if (eitherOpenToDistance) {
    return makeDimension(ScoringDimension.LOCATION, 50,
      `ערים שונות (${internal.city} ↔ ${external.city}) — צד אחד לפחות פתוח למרחק`);
  }

  return makeDimension(ScoringDimension.LOCATION, LOCATION.DIFFERENT_REGION_SCORE,
    `ערים שונות: ${internal.city} ↔ ${external.city}`);
}

// ── Dimension 6: Mutual expectations ──────────────────────

function scoreMutualExpectations(
  internal: MatchableInternal,
  external: MatchableExternal,
): DimensionScore {
  // BIDIRECTIONAL: score BOTH sides' soft preferences against the other side.
  // Final score is the MIN of forward and reverse — a match is only as
  // strong as the weaker side's preference alignment.
  const forward = scoreSoftPrefs(
    internal.softPreferences,
    getSubjectFieldsSnapshot(external),
  );
  const reverse = scoreSoftPrefs(
    external.softPreferences ?? [],
    getSubjectFieldsSnapshot(internal),
  );

  const hasForward = internal.softPreferences.length > 0;
  const hasReverse = (external.softPreferences?.length ?? 0) > 0;
  const hasSoftPrefs = hasForward || hasReverse;

  // Direct shared-goals comparison (children-count + torah/career
  // priority). Independent of stated soft-preferences — two people who
  // both want a large torah-focused home align even if neither wrote
  // an explicit preference. Folded in here rather than as a 9th
  // weighted dimension, to preserve the 8-dimension engine contract.
  const goals = scoreSharedGoals(internal, external);

  if (!hasSoftPrefs && !goals.has) {
    // No stated expectations on EITHER side is missing signal, not a strong
    // match. Kept modest (below neutral) so pairs with real, aligned
    // expectations rise above data-less pairs instead of clustering together.
    return makeDimension(ScoringDimension.MUTUAL_EXPECTATIONS, 50,
      'אין העדפות רכות או מטרות משותפות בשני הצדדים — נתון חסר');
  }

  const softScore = hasForward && hasReverse
    ? Math.min(forward, reverse)
    : (hasForward ? forward : reverse);

  let score: number;
  let detail: string;
  if (hasSoftPrefs && goals.has) {
    // Blend: stated preferences lead (0.6), structured goals refine (0.4).
    score = Math.round(softScore * 0.6 + goals.score * 0.4);
    detail = `העדפות רכות ${softScore}% + ${goals.detail} → ${score}%`;
  } else if (hasSoftPrefs) {
    score = softScore;
    detail =
      hasForward && hasReverse ? `העדפות רכות (שני הצדדים): ישיר ${forward}%, הפוך ${reverse}% → ${score}%`
      : hasForward ? `העדפות רכות (פנימי → חיצוני): ${score}%`
      : `העדפות רכות (חיצוני → פנימי): ${score}%`;
  } else {
    score = goals.score;
    detail = goals.detail;
  }

  return makeDimension(ScoringDimension.MUTUAL_EXPECTATIONS, Math.max(0, Math.min(100, score)), detail);
}

/**
 * Direct candidate-to-candidate comparison of structured shared goals.
 * Only the sub-fields present on BOTH sides contribute; returns has:false
 * when there's nothing to compare so the caller stays backward-compatible.
 */
function scoreSharedGoals(
  internal: MatchableInternal,
  external: MatchableExternal,
): { score: number; has: boolean; detail: string } {
  const parts: number[] = [];
  const labels: string[] = [];

  const childClose = childrenPreferenceCloseness(internal.childrenPreference, external.childrenPreference);
  if (childClose !== undefined) {
    parts.push(childClose);
    labels.push(`ילדים ${Math.round(childClose * 100)}%`);
  }
  const careerClose = careerPriorityCloseness(internal.careerPriority, external.careerPriority);
  if (careerClose !== undefined) {
    parts.push(careerClose);
    labels.push(`קריירה ${Math.round(careerClose * 100)}%`);
  }

  if (parts.length === 0) return { score: 0, has: false, detail: '' };
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return { score: Math.round(avg * 100), has: true, detail: `מטרות משותפות (${labels.join(', ')})` };
}

function scoreSoftPrefs(
  prefs: Array<{ field: string; value: unknown; importance: string }>,
  subjectFields: Record<string, unknown>,
): number {
  if (prefs.length === 0) return 50;
  const importanceWeights = { must_have: 4, important: 3, nice_to_have: 1.5, flexible: 0.5 };
  let totalWeight = 0;
  let weightedHits = 0;
  for (const pref of prefs) {
    const w = (importanceWeights as Record<string, number>)[pref.importance] ?? 1;
    totalWeight += w;
    const subjectValue = subjectFields[pref.field];
    if (subjectValue === undefined || subjectValue === null) {
      weightedHits += w * 0.4;
      continue;
    }
    if (matchesSoftPreference(subjectValue, pref.value)) {
      weightedHits += w;
    } else {
      weightedHits += w * 0.15;
    }
  }
  return totalWeight > 0 ? Math.round((weightedHits / totalWeight) * 100) : 50;
}

// ── Dimension 7: Life stage / maturity ────────────────────

function scoreLifeStage(
  internal: MatchableInternal,
  external: MatchableExternal,
): DimensionScore {
  const closeness = lifeStageCloseness(internal.lifeStage, external.lifeStage);
  const score = Math.round(closeness * 100);
  const detail = `קרבת שלב חיים: ${score}%`;

  return makeDimension(ScoringDimension.LIFE_STAGE, score, detail);
}

// ── Dimension 8: Flexibility / creative override ──────────

function scoreFlexibility(
  internal: MatchableInternal,
  external: MatchableExternal,
  context: MatchingContext,
): DimensionScore {
  // This dimension rewards matches that cross boundaries when the data
  // supports it. It's the "Shadchan's intuition" dimension — deterministic
  // but creative.

  let score = 30; // baseline: neutral (not penalized if no creative factors)
  const factors: string[] = [];

  // Cross-sector with high lifestyle closeness
  const sectorClose = combinedSectorCloseness(
    internal.sectorGroup, internal.subSector,
    external.sectorGroup, external.subSector,
  );
  const lifestyleClose = lifestyleCloseness(internal.lifestyleTone, external.lifestyleTone);

  if (sectorClose < 0.5 && lifestyleClose >= OVERRIDE.LIFESTYLE_OVERRIDES_SECTOR_MIN) {
    score += 30;
    factors.push('התאמת אורח חיים גבוהה מפצה על פער מגזרי');
  }

  // Both candidates show openness
  if (internal.openness.openToOtherSectors) {
    score += 10;
    factors.push('המועמד/ת פתוח/ה למגזרים אחרים');
  }
  if (internal.openness.openToAgeDifference) {
    score += 5;
    factors.push('פתיחות לפער גיל');
  }

  // Semantic similarity boost (if provided from embeddings)
  const semanticScore = context.semanticSimilarities?.get(external._id);
  if (semanticScore !== undefined && semanticScore > 0.7) {
    score += 15;
    factors.push(`דמיון סמנטי גבוה (${(semanticScore * 100).toFixed(0)}%)`);
  }

  // Discovery mode general boost
  if (context.mode === 'discovery') {
    score += 10;
    factors.push('מצב גילוי פעיל');
  }

  score = Math.max(0, Math.min(100, score));
  const detail = factors.length > 0
    ? `גורמי גמישות: ${factors.join('; ')}`
    : 'אין גורמי גמישות מיוחדים';

  return makeDimension(ScoringDimension.FLEXIBILITY, score, detail);
}

// ── Helpers ───────────────────────────────────────────────

function makeDimension(
  dimension: ScoringDimension,
  score: number,
  detail: string,
): DimensionScore {
  return { dimension, score, weight: 0, weightedScore: 0, detail };
}

function ageFromDob(dob: Date): number {
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }
  return age;
}

function isSecondChapterCase(
  internal: MatchableInternal,
  external: MatchableExternal,
): boolean {
  const secondStatuses = ['divorced', 'widowed', 'separated'];
  return secondStatuses.includes(internal.personalStatus) ||
    (external.personalStatus !== undefined && secondStatuses.includes(external.personalStatus));
}

function getExternalField(external: MatchableExternal, field: string): unknown {
  // Kept for backward compatibility; soft-pref scoring now uses
  // getSubjectFieldsSnapshot for bidirectional evaluation.
  return getSubjectFieldsSnapshot(external)[field];
}

/**
 * Snapshot a subject's fields for soft-preference / constraint scoring.
 * Works for both MatchableInternal and MatchableExternal.
 */
function getSubjectFieldsSnapshot(
  subject: MatchableInternal | MatchableExternal,
): Record<string, unknown> {
  const s = subject as MatchableInternal & MatchableExternal;
  const fields: Record<string, unknown> = {
    gender: s.gender,
    city: s.city,
    region: s.region,
    ethnicity: s.ethnicity,
    sectorGroup: s.sectorGroup,
    subSector: s.subSector,
    lifestyleTone: s.lifestyleTone,
    personalStatus: s.personalStatus,
    lifeStage: s.lifeStage,
    studyWorkDirection: s.studyWorkDirection,
    childrenPreference: s.childrenPreference,
    careerPriority: s.careerPriority,
    height: s.height,
  };
  if ('age' in s && typeof s.age === 'number') {
    fields['age'] = s.age;
  } else if ('dateOfBirth' in s && s.dateOfBirth instanceof Date) {
    fields['age'] = ageFromDob(s.dateOfBirth);
  }
  if ('numberOfChildren' in s) {
    fields['numberOfChildren'] = s.numberOfChildren;
  }
  return fields;
}

/** Age-preference violation check used bidirectionally in scoreAge. */
function violatesAgePref(
  pref: { min?: number; max?: number; flexibility?: string } | undefined,
  candidateAge: number,
): boolean {
  if (!pref) return false;
  const flexYears = pref.flexibility === 'strict' ? 0
    : pref.flexibility === 'very_flexible' ? OVERRIDE.AGE_OVERRIDE_MAX_YEARS
    : Math.floor(OVERRIDE.AGE_OVERRIDE_MAX_YEARS / 2);
  if (pref.min !== undefined && candidateAge < pref.min - flexYears) return true;
  if (pref.max !== undefined && candidateAge > pref.max + flexYears) return true;
  return false;
}

/**
 * True when EITHER side's stated age preference is violated beyond the
 * ±tolerance (default ±1 year — see violatesAgePref). Soft: the pair is
 * still shown, but flagged as an out-of-range exception so the operator
 * sees it's outside a stated range and can decide anyway.
 */
export function pairAgeOutOfRange(
  internal: MatchableInternal,
  external: MatchableExternal,
): boolean {
  if (!external.age) return false;
  const internalAge = ageFromDob(internal.dateOfBirth);
  const internalViolated = violatesAgePref(internal.agePreferences, external.age);
  const externalViolated = external.agePreferences !== undefined
    && violatesAgePref(external.agePreferences, internalAge);
  return internalViolated || externalViolated;
}

function matchesSoftPreference(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (expected as unknown[]).includes(actual);
  }
  return actual === expected;
}
