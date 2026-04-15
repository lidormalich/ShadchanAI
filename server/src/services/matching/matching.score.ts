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

  // Collect strengths (score >= 75) and attention points (score <= 40)
  const strengths: string[] = [];
  const attentionPoints: string[] = [];
  for (const dim of dimensions) {
    if (dim.score >= 75) strengths.push(dim.detail);
    if (dim.score <= 40 && dim.weight > 0) attentionPoints.push(dim.detail);
  }

  // Collect override reasons
  const overrideReasons: string[] = [];
  let flexibilityOverrideApplied = false;
  if (isSecondChapter) {
    overrideReasons.push('Second-chapter case: relaxed age and sector scoring applied');
  }
  if (isDiscovery) {
    const ageScore = dimensions.find(d => d.dimension === ScoringDimension.AGE);
    if (ageScore && ageScore.score > 0 && ageScore.score < 50) {
      overrideReasons.push('Discovery mode: widened age range considered');
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
    return makeDimension(ScoringDimension.AGE, 50, 'External candidate age unknown — neutral score');
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
    gap <= bands.preferred ? 'preferred'
    : gap <= bands.flexible ? 'flexible'
    : gap <= bands.outer ? 'outer'
    : gap <= bands.hard ? 'hard-edge'
    : 'beyond-hard';

  const detail = `Age gap: ${gap} years (${bandLabel} band; internal ${internalAge}, external ${external.age})${isSecondChapter ? ' [second-chapter]' : ''}`;

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
  const detail = `Sector closeness: ${(closeness * 100).toFixed(0)}% (${internal.sectorGroup}/${internal.subSector ?? '?'} ↔ ${external.sectorGroup ?? '?'}/${external.subSector ?? '?'})`;

  return makeDimension(ScoringDimension.SECTOR, score, detail);
}

// ── Dimension 3: Lifestyle / Home style ───────────────────

function scoreLifestyle(
  internal: MatchableInternal,
  external: MatchableExternal,
): DimensionScore {
  const closeness = lifestyleCloseness(internal.lifestyleTone, external.lifestyleTone);
  const score = Math.round(closeness * 100);
  const detail = `Lifestyle closeness: ${score}% (${internal.lifestyleTone ?? '?'} ↔ ${external.lifestyleTone ?? '?'})`;

  return makeDimension(ScoringDimension.LIFESTYLE, score, detail);
}

// ── Dimension 4: Study-work direction ─────────────────────

function scoreStudyWork(
  internal: MatchableInternal,
  external: MatchableExternal,
): DimensionScore {
  const closeness = studyWorkCloseness(internal.studyWorkDirection, external.studyWorkDirection);
  const score = Math.round(closeness * 100);
  const detail = `Study-work closeness: ${score}% (${internal.studyWorkDirection ?? '?'} ↔ ${external.studyWorkDirection ?? '?'})`;

  return makeDimension(ScoringDimension.STUDY_WORK, score, detail);
}

// ── Dimension 5: Location ─────────────────────────────────

function scoreLocation(
  internal: MatchableInternal,
  external: MatchableExternal,
): DimensionScore {
  const internalCity = internal.city?.toLowerCase().trim();
  const externalCity = external.city?.toLowerCase().trim();

  if (!internalCity || !externalCity) {
    return makeDimension(ScoringDimension.LOCATION, LOCATION.MISSING_DATA_SCORE,
      'Location data incomplete — neutral score');
  }

  if (internalCity === externalCity) {
    return makeDimension(ScoringDimension.LOCATION, LOCATION.SAME_CITY_SCORE,
      `Same city: ${internal.city}`);
  }

  // BIDIRECTIONAL: check each side's city against the OTHER side's preferred cities
  const internalPreferredCities = internal.locationPreferences?.cities?.map((c) => c.toLowerCase().trim()) ?? [];
  const externalPreferredCities = external.locationPreferences?.cities?.map((c) => c.toLowerCase().trim()) ?? [];
  const externalCityInInternalPrefs = internalPreferredCities.includes(externalCity);
  const internalCityInExternalPrefs = externalPreferredCities.includes(internalCity);
  if (externalCityInInternalPrefs || internalCityInExternalPrefs) {
    return makeDimension(ScoringDimension.LOCATION, 90,
      `Cities align with one side's preferences (${internal.city} ↔ ${external.city})`);
  }

  // Region hint on either side
  const anyRegionHint = (internal.locationPreferences?.regions?.length ?? 0) > 0
    || (external.locationPreferences?.regions?.length ?? 0) > 0;
  if (anyRegionHint) {
    return makeDimension(ScoringDimension.LOCATION, LOCATION.SAME_REGION_SCORE,
      `Different cities but region preferences specified`);
  }

  // Either side willing to relocate / open to long distance (BIDIRECTIONAL)
  const eitherWillingToRelocate = Boolean(
    internal.locationPreferences?.willingToRelocate || external.locationPreferences?.willingToRelocate,
  );
  if (eitherWillingToRelocate) {
    return makeDimension(ScoringDimension.LOCATION, LOCATION.DIFFERENT_REGION_RELOCATE_WILLING,
      `Different cities (${internal.city} ↔ ${external.city}) — at least one side willing to relocate`);
  }

  const eitherOpenToDistance = internal.openness.openToLongDistance
    || external.openness?.openToLongDistance === true;
  if (eitherOpenToDistance) {
    return makeDimension(ScoringDimension.LOCATION, 50,
      `Different cities (${internal.city} ↔ ${external.city}) — at least one side open to long distance`);
  }

  return makeDimension(ScoringDimension.LOCATION, LOCATION.DIFFERENT_REGION_SCORE,
    `Different cities: ${internal.city} ↔ ${external.city}`);
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

  if (!hasForward && !hasReverse) {
    return makeDimension(ScoringDimension.MUTUAL_EXPECTATIONS, 60,
      'No soft preferences specified on either side — neutral score');
  }

  const score = hasForward && hasReverse
    ? Math.min(forward, reverse)
    : (hasForward ? forward : reverse);

  const detail =
    hasForward && hasReverse ? `Soft preferences (both sides): forward ${forward}%, reverse ${reverse}% → ${score}%`
    : hasForward ? `Soft preferences (internal → external): ${score}%`
    : `Soft preferences (external → internal): ${score}%`;

  return makeDimension(ScoringDimension.MUTUAL_EXPECTATIONS, Math.max(0, Math.min(100, score)), detail);
}

function scoreSoftPrefs(
  prefs: Array<{ field: string; value: unknown; importance: string }>,
  subjectFields: Record<string, unknown>,
): number {
  if (prefs.length === 0) return 60;
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
  return totalWeight > 0 ? Math.round((weightedHits / totalWeight) * 100) : 60;
}

// ── Dimension 7: Life stage / maturity ────────────────────

function scoreLifeStage(
  internal: MatchableInternal,
  external: MatchableExternal,
): DimensionScore {
  const closeness = lifeStageCloseness(internal.lifeStage, external.lifeStage);
  const score = Math.round(closeness * 100);
  const detail = `Life-stage closeness: ${score}% (${internal.lifeStage ?? '?'} ↔ ${external.lifeStage ?? '?'})`;

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
    factors.push('High lifestyle compatibility overrides sector gap');
  }

  // Both candidates show openness
  if (internal.openness.openToOtherSectors) {
    score += 10;
    factors.push('Internal candidate open to other sectors');
  }
  if (internal.openness.openToAgeDifference) {
    score += 5;
    factors.push('Open to age difference');
  }

  // Semantic similarity boost (if provided from embeddings)
  const semanticScore = context.semanticSimilarities?.get(external._id);
  if (semanticScore !== undefined && semanticScore > 0.7) {
    score += 15;
    factors.push(`High semantic similarity (${(semanticScore * 100).toFixed(0)}%)`);
  }

  // Discovery mode general boost
  if (context.mode === 'discovery') {
    score += 10;
    factors.push('Discovery mode active');
  }

  score = Math.max(0, Math.min(100, score));
  const detail = factors.length > 0
    ? `Flexibility factors: ${factors.join('; ')}`
    : 'No special flexibility factors';

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
    sectorGroup: s.sectorGroup,
    subSector: s.subSector,
    lifestyleTone: s.lifestyleTone,
    personalStatus: s.personalStatus,
    lifeStage: s.lifeStage,
    studyWorkDirection: s.studyWorkDirection,
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

function matchesSoftPreference(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (expected as unknown[]).includes(actual);
  }
  return actual === expected;
}
