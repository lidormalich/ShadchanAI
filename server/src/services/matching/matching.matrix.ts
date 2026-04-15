// ═══════════════════════════════════════════════════════════
// ShadchanAI — Closeness Matrix Lookup
//
// Provides closeness values between sector groups, sub-sectors,
// lifestyle tones, life stages, and study-work directions.
//
// All lookups are symmetrical and return 0–1 where:
//   1.0 = identical / perfectly compatible
//   0.0 = completely incompatible (but NOT automatically blocked)
//
// The engine uses these values for scoring, NOT for hard blocking.
// ═══════════════════════════════════════════════════════════

import type { ClosenessValue } from './matching.types.js';
import {
  SECTOR_GROUP_CLOSENESS,
  SUB_SECTOR_CLOSENESS,
  LIFESTYLE_CLOSENESS,
  LIFE_STAGE_CLOSENESS,
  STUDY_WORK_CLOSENESS,
} from './matching.constants.js';

/**
 * Look up closeness between two sector groups.
 * Returns 0.5 if either value is missing (neutral assumption).
 */
export function sectorGroupCloseness(
  a: string | undefined,
  b: string | undefined,
): ClosenessValue {
  if (!a || !b) return 0.5;
  return SECTOR_GROUP_CLOSENESS[a]?.[b] ?? 0.3;
}

/**
 * Look up closeness between two sub-sectors.
 * Falls back to sector-group closeness if sub-sectors are missing.
 */
export function subSectorCloseness(
  subA: string | undefined,
  subB: string | undefined,
  groupA: string | undefined,
  groupB: string | undefined,
): ClosenessValue {
  // Both sub-sectors present → use the detailed matrix
  if (subA && subB) {
    return SUB_SECTOR_CLOSENESS[subA]?.[subB] ?? sectorGroupCloseness(groupA, groupB);
  }
  // Fall back to sector-group level
  return sectorGroupCloseness(groupA, groupB);
}

/**
 * Combined sector score: blends group-level and sub-sector-level closeness.
 * Sub-sector is weighted higher when available since it's more precise.
 */
export function combinedSectorCloseness(
  groupA: string | undefined,
  subA: string | undefined,
  groupB: string | undefined,
  subB: string | undefined,
): ClosenessValue {
  const groupClose = sectorGroupCloseness(groupA, groupB);
  const subClose = subSectorCloseness(subA, subB, groupA, groupB);

  // If we have sub-sector data for both, weight it 70/30 sub/group
  if (subA && subB) {
    return subClose * 0.7 + groupClose * 0.3;
  }
  // Otherwise use group-level only
  return groupClose;
}

/**
 * Look up closeness between two lifestyle tones.
 */
export function lifestyleCloseness(
  a: string | undefined,
  b: string | undefined,
): ClosenessValue {
  if (!a || !b) return 0.5;
  return LIFESTYLE_CLOSENESS[a]?.[b] ?? 0.5;
}

/**
 * Look up closeness between two life stages.
 */
export function lifeStageCloseness(
  a: string | undefined,
  b: string | undefined,
): ClosenessValue {
  if (!a || !b) return 0.5;
  return LIFE_STAGE_CLOSENESS[a]?.[b] ?? 0.5;
}

/**
 * Look up closeness between two study-work directions.
 */
export function studyWorkCloseness(
  a: string | undefined,
  b: string | undefined,
): ClosenessValue {
  if (!a || !b) return 0.5;
  return STUDY_WORK_CLOSENESS[a]?.[b] ?? 0.5;
}
