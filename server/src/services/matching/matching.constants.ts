// ═══════════════════════════════════════════════════════════
// ShadchanAI — Matching Engine Constants
//
// All thresholds, weights, matrices, and tuning knobs live
// here. Separated from logic so they can be adjusted without
// changing engine code.
// ═══════════════════════════════════════════════════════════

import type { MatchingWeights, ClosenessValue } from './matching.types.js';

// ── Default scoring weights (must sum to 1.0) ────────────

export const DEFAULT_WEIGHTS: MatchingWeights = {
  age: 0.15,
  sector: 0.15,
  lifestyle: 0.15,
  study_work: 0.10,
  location: 0.10,
  mutual_expectations: 0.15,
  life_stage: 0.10,
  flexibility: 0.10,
};

// ── Match-type classification thresholds ──────────────────

export const MATCH_TYPE_THRESHOLDS = {
  safe:     { minScore: 80, minConfidence: 70 },
  balanced: { minScore: 60, minConfidence: 50 },
  creative: { minScore: 40, minConfidence: 30 },
  // Below creative thresholds → risky
} as const;

// ── Suitable / weak bucket thresholds ─────────────────────
//
// Used by the compatibility board (suitable vs weak bucket) and the
// match-scan PairScore bucketing. Centralized here so the two consumers
// can never disagree on what "suitable" means.

/** Minimum engine matchScore for a pair to be considered "suitable" */
export const SUITABLE_SCORE_MIN = 70;
/** Minimum engine confidenceScore for a pair to be considered "suitable" */
export const SUITABLE_CONFIDENCE_MIN = 60;

// ── Mode-specific filters ─────────────────────────────────

export const MODE_CONFIG = {
  strict: {
    /** Only return safe + balanced */
    allowedMatchTypes: ['safe', 'balanced'] as const,
    maxResults: 15,
    /** Minimum score to even consider */
    scoreFloor: 55,
  },
  discovery: {
    /** Return all types including creative and risky */
    allowedMatchTypes: ['safe', 'balanced', 'creative', 'risky'] as const,
    maxResults: 30,
    scoreFloor: 30,
  },
} as const;

// ── Decline cooldown ──────────────────────────────────────

/** Days after a decline before the same pair can be re-suggested */
export const DECLINE_COOLDOWN_DAYS = 60;

// ── Penalty caps and rates ────────────────────────────────

export const PENALTY = {
  /** Stale external profile: points deducted per 30 days past threshold */
  STALE_THRESHOLD_DAYS: 60,
  STALE_RATE_PER_30_DAYS: 5,
  STALE_MAX: 20,

  /** Direct history: recent decline for this exact pair */
  HISTORY_PER_DECLINE: 3,
  HISTORY_MAX: 15,

  /** Timing: if internal candidate was recently sent a suggestion */
  TIMING_THRESHOLD_DAYS: 7,
  TIMING_PENALTY: 5,

  /** Load: too many active suggestions already */
  LOAD_THRESHOLD: 5,
  LOAD_PER_EXTRA: 2,
  LOAD_MAX: 10,

  // ── Pattern-based penalty hooks (future extension) ──────
  // These fire only when the caller populates the corresponding
  // MatchingContext fields. Keeping them in the penalty layer
  // so pattern detection can be plugged in without changing
  // the engine surface.

  /** Pattern: similar-profile rejection history. Each prior decline
   *  against a profile similar to this external adds this penalty. */
  HISTORY_PATTERN_PER_DECLINE: 2,
  HISTORY_PATTERN_MAX: 10,

  /** Fatigue: external candidate has received many similar proposals
   *  recently, reducing conversion likelihood. */
  FATIGUE_THRESHOLD: 3,
  FATIGUE_PER_EXTRA: 2,
  FATIGUE_MAX: 10,

  /** Internal candidate has received many proposals recently */
  INTERNAL_FATIGUE_THRESHOLD: 4,
  INTERNAL_FATIGUE_PER_EXTRA: 2,
  INTERNAL_FATIGUE_MAX: 8,

  /** Personal-status mismatch: exactly one side is "second chapter"
   *  (divorced / separated / widowed) and the other is single. NOT a block —
   *  the pair stays eligible but sinks toward the bottom so a single sees
   *  singles first. Waived when the single side is explicitly open to divorced. */
  STATUS_MISMATCH: 25,
} as const;

// ── Confidence scoring weights ────────────────────────────

export const CONFIDENCE = {
  /** Base confidence for a fully complete pair */
  BASE: 100,

  /** Deductions for missing/unreliable data */
  MISSING_GENDER: 30,
  MISSING_AGE: 15,
  MISSING_SECTOR: 15,
  MISSING_CITY: 8,
  MISSING_LIFESTYLE: 8,
  MISSING_STUDY_WORK: 5,
  MISSING_LIFE_STAGE: 5,
  MISSING_PERSONAL_STATUS: 5,

  /** Age reliability deductions */
  AGE_APPROXIMATE: 5,
  AGE_ESTIMATED: 12,
  AGE_UNKNOWN: 20,

  /** Stale external profile deduction */
  STALE_DEDUCTION: 15,

  /** Low internal profile completion deductions */
  LOW_COMPLETION_THRESHOLD: 60,
  LOW_COMPLETION_DEDUCTION: 10,

  /** No verified date in last N days */
  UNVERIFIED_DAYS: 90,
  UNVERIFIED_DEDUCTION: 8,
} as const;

// ── Age scoring — explicit band configuration ─────────────
//
// Four bands model the real-world age tolerance curve:
//   preferred → full score (100)
//   flexible  → smooth decay to ~70
//   outer     → decay to ~30
//   hard      → decay to 0; beyond this the score is 0
//
// These are NOT hard blockers — they're soft score bands.
// Hard age blocking only happens via explicit user constraints.
//
// Bands vary by life stage and second-chapter status. The
// selectAgeBands() helper in matching.score.ts picks the right
// config per pair, which makes life-stage/age-group tuning
// a future-safe extension point.

export interface AgeBandConfig {
  preferred: number;
  flexible: number;
  outer: number;
  hard: number;
}

export const DEFAULT_AGE_BANDS: AgeBandConfig = {
  preferred: 2,
  flexible: 5,
  outer: 10,
  hard: 15,
};

/** Divorced / widowed / separated candidates: age is less constraining */
export const SECOND_CHAPTER_AGE_BANDS: AgeBandConfig = {
  preferred: 4,
  flexible: 8,
  outer: 13,
  hard: 20,
};

/** Mature / established-career: wider tolerance */
export const MATURE_AGE_BANDS: AgeBandConfig = {
  preferred: 3,
  flexible: 7,
  outer: 12,
  hard: 18,
};

/** Very young candidates (post-high-school / national service): tighter */
export const YOUNG_AGE_BANDS: AgeBandConfig = {
  preferred: 1,
  flexible: 3,
  outer: 7,
  hard: 10,
};

export const AGE = {
  /** Extra flexible-band years in discovery mode */
  DISCOVERY_FLEXIBLE_BONUS: 2,
  /** Extra outer-band years in discovery mode */
  DISCOVERY_OUTER_BONUS: 3,
  /** Gender-based direction preference: culturally common for male to be same age or older */
  MALE_OLDER_BONUS: 5,
  /** Age-preference violation penalty (soft scoring — not a hard block) */
  PREFERENCE_VIOLATION_PENALTY: 25,
} as const;

// ── Location scoring ──────────────────────────────────────

export const LOCATION = {
  SAME_CITY_SCORE: 100,
  SAME_REGION_SCORE: 75,
  DIFFERENT_REGION_RELOCATE_WILLING: 55,
  DIFFERENT_REGION_SCORE: 30,
  /** Missing city data: neutral-low score. The real hit comes from
   *  confidence-score deduction for missing city, not from inflating
   *  this dimension's score. */
  MISSING_DATA_SCORE: 35,
  /** When either side is willing to relocate / open to distance, region
   *  distance never tanks the score below this floor (city/distance is
   *  never a disqualifier — it's a soft preference). */
  RELOCATE_FLOOR: 55,
} as const;

// ── Region closeness matrix (8×8, symmetric) ──────────────
//
// Coarse Israeli-geography adjacency: 1.0 = same region, lower =
// farther / harder to commute. Region is the PRIMARY location
// signal; same-city still scores a perfect 100 on top of this.
// Values are commute-intuition, NOT exact km — they only need to
// rank "how far apart" for the soft location dimension.
//
//   north · haifa_krayot · sharon · gush_dan · jerusalem · shfela · south · yosh

export const REGION_CLOSENESS: Record<string, Record<string, ClosenessValue>> = {
  north:        { north: 1.0,  haifa_krayot: 0.7,  sharon: 0.4,  gush_dan: 0.3,  jerusalem: 0.2,  shfela: 0.2,  south: 0.15, yosh: 0.2  },
  haifa_krayot: { north: 0.7,  haifa_krayot: 1.0,  sharon: 0.6,  gush_dan: 0.45, jerusalem: 0.25, shfela: 0.3,  south: 0.2,  yosh: 0.25 },
  sharon:       { north: 0.4,  haifa_krayot: 0.6,  sharon: 1.0,  gush_dan: 0.75, jerusalem: 0.4,  shfela: 0.5,  south: 0.3,  yosh: 0.45 },
  gush_dan:     { north: 0.3,  haifa_krayot: 0.45, sharon: 0.75, gush_dan: 1.0,  jerusalem: 0.5,  shfela: 0.7,  south: 0.4,  yosh: 0.5  },
  jerusalem:    { north: 0.2,  haifa_krayot: 0.25, sharon: 0.4,  gush_dan: 0.5,  jerusalem: 1.0,  shfela: 0.55, south: 0.4,  yosh: 0.65 },
  shfela:       { north: 0.2,  haifa_krayot: 0.3,  sharon: 0.5,  gush_dan: 0.7,  jerusalem: 0.55, shfela: 1.0,  south: 0.55, yosh: 0.45 },
  south:        { north: 0.15, haifa_krayot: 0.2,  sharon: 0.3,  gush_dan: 0.4,  jerusalem: 0.4,  shfela: 0.55, south: 1.0,  yosh: 0.3  },
  yosh:         { north: 0.2,  haifa_krayot: 0.25, sharon: 0.45, gush_dan: 0.5,  jerusalem: 0.65, shfela: 0.45, south: 0.3,  yosh: 1.0  },
};

// ── Shared-goals closeness (fold into mutual_expectations) ─
// Direct candidate-to-candidate comparison of structured goals.
// flexible/undecided on either side → high (no friction).

export const CHILDREN_PREFERENCE_CLOSENESS: Record<string, Record<string, ClosenessValue>> = {
  large_family: { large_family: 1.0,  balanced: 0.6, small_family: 0.2, flexible: 0.8, undecided: 0.7 },
  balanced:     { large_family: 0.6,  balanced: 1.0, small_family: 0.6, flexible: 0.85, undecided: 0.7 },
  small_family: { large_family: 0.2,  balanced: 0.6, small_family: 1.0, flexible: 0.8, undecided: 0.7 },
  flexible:     { large_family: 0.8,  balanced: 0.85, small_family: 0.8, flexible: 1.0, undecided: 0.85 },
  undecided:    { large_family: 0.7,  balanced: 0.7, small_family: 0.7, flexible: 0.85, undecided: 0.7 },
};

export const CAREER_PRIORITY_CLOSENESS: Record<string, Record<string, ClosenessValue>> = {
  torah_focused:  { torah_focused: 1.0, balanced: 0.6, career_focused: 0.2, flexible: 0.8 },
  balanced:       { torah_focused: 0.6, balanced: 1.0, career_focused: 0.6, flexible: 0.85 },
  career_focused: { torah_focused: 0.2, balanced: 0.6, career_focused: 1.0, flexible: 0.8 },
  flexible:       { torah_focused: 0.8, balanced: 0.85, career_focused: 0.8, flexible: 1.0 },
};

// ── Life-stage compatibility ──────────────────────────────

export const LIFE_STAGE_CLOSENESS: Record<string, Record<string, ClosenessValue>> = {
  post_high_school:    { post_high_school: 1.0, national_service: 0.9, army: 0.85, yeshiva_seminary: 0.85, early_studies: 0.7, mid_studies: 0.5, early_career: 0.4, established_career: 0.2, mature: 0.1 },
  national_service:    { post_high_school: 0.9, national_service: 1.0, army: 0.95, yeshiva_seminary: 0.85, early_studies: 0.8, mid_studies: 0.6, early_career: 0.5, established_career: 0.3, mature: 0.1 },
  army:                { post_high_school: 0.85, national_service: 0.95, army: 1.0, yeshiva_seminary: 0.7, early_studies: 0.8, mid_studies: 0.6, early_career: 0.5, established_career: 0.3, mature: 0.1 },
  yeshiva_seminary:    { post_high_school: 0.85, national_service: 0.85, army: 0.7, yeshiva_seminary: 1.0, early_studies: 0.8, mid_studies: 0.6, early_career: 0.5, established_career: 0.3, mature: 0.15 },
  early_studies:       { post_high_school: 0.7, national_service: 0.8, army: 0.8, yeshiva_seminary: 0.8, early_studies: 1.0, mid_studies: 0.85, early_career: 0.7, established_career: 0.4, mature: 0.2 },
  mid_studies:         { post_high_school: 0.5, national_service: 0.6, army: 0.6, yeshiva_seminary: 0.6, early_studies: 0.85, mid_studies: 1.0, early_career: 0.85, established_career: 0.6, mature: 0.3 },
  early_career:        { post_high_school: 0.4, national_service: 0.5, army: 0.5, yeshiva_seminary: 0.5, early_studies: 0.7, mid_studies: 0.85, early_career: 1.0, established_career: 0.8, mature: 0.5 },
  established_career:  { post_high_school: 0.2, national_service: 0.3, army: 0.3, yeshiva_seminary: 0.3, early_studies: 0.4, mid_studies: 0.6, early_career: 0.8, established_career: 1.0, mature: 0.75 },
  mature:              { post_high_school: 0.1, national_service: 0.1, army: 0.1, yeshiva_seminary: 0.15, early_studies: 0.2, mid_studies: 0.3, early_career: 0.5, established_career: 0.75, mature: 1.0 },
};

// ── Study-work compatibility (11×11) ──────────────────────
//
// Reflects Israeli religious-life trajectories:
//   - full_time_torah: kollel / long-term yeshiva
//   - torah_with_work: part-time learning + parnassa
//   - academic_studies / professional_training / working / entrepreneurial
//   - military_career: career IDF
//   - hesder: yeshiva + shortened army service (bridge path)
//   - mechina_army: pre-army religious academy + full army service
//   - sherut_leumi: civic national service (often dati leumi women)
//
// Hesder, mechina_army, and sherut_leumi are bridge paths — they
// legitimately sit close to BOTH torah-oriented and military/civic
// tracks. The matrix reflects this nuance.

export const STUDY_WORK_CLOSENESS: Record<string, Record<string, ClosenessValue>> = {
  full_time_torah:       { full_time_torah: 1.0,  torah_with_work: 0.8,  academic_studies: 0.3,  professional_training: 0.35, working: 0.25, military_career: 0.15, entrepreneurial: 0.3,  hesder: 0.6,  mechina_army: 0.35, sherut_leumi: 0.3,  undecided: 0.5 },
  torah_with_work:       { full_time_torah: 0.8,  torah_with_work: 1.0,  academic_studies: 0.6,  professional_training: 0.65, working: 0.6,  military_career: 0.35, entrepreneurial: 0.55, hesder: 0.75, mechina_army: 0.65, sherut_leumi: 0.6,  undecided: 0.55 },
  academic_studies:      { full_time_torah: 0.3,  torah_with_work: 0.6,  academic_studies: 1.0,  professional_training: 0.8,  working: 0.7,  military_career: 0.5,  entrepreneurial: 0.7,  hesder: 0.6,  mechina_army: 0.55, sherut_leumi: 0.65, undecided: 0.6 },
  professional_training: { full_time_torah: 0.35, torah_with_work: 0.65, academic_studies: 0.8,  professional_training: 1.0,  working: 0.8,  military_career: 0.5,  entrepreneurial: 0.7,  hesder: 0.55, mechina_army: 0.55, sherut_leumi: 0.6,  undecided: 0.6 },
  working:               { full_time_torah: 0.25, torah_with_work: 0.6,  academic_studies: 0.7,  professional_training: 0.8,  working: 1.0,  military_career: 0.6,  entrepreneurial: 0.75, hesder: 0.55, mechina_army: 0.55, sherut_leumi: 0.6,  undecided: 0.55 },
  military_career:       { full_time_torah: 0.15, torah_with_work: 0.35, academic_studies: 0.5,  professional_training: 0.5,  working: 0.6,  military_career: 1.0,  entrepreneurial: 0.5,  hesder: 0.7,  mechina_army: 0.85, sherut_leumi: 0.75, undecided: 0.4 },
  entrepreneurial:       { full_time_torah: 0.3,  torah_with_work: 0.55, academic_studies: 0.7,  professional_training: 0.7,  working: 0.75, military_career: 0.5,  entrepreneurial: 1.0,  hesder: 0.55, mechina_army: 0.5,  sherut_leumi: 0.55, undecided: 0.55 },
  hesder:                { full_time_torah: 0.6,  torah_with_work: 0.75, academic_studies: 0.6,  professional_training: 0.55, working: 0.55, military_career: 0.7,  entrepreneurial: 0.55, hesder: 1.0,  mechina_army: 0.8,  sherut_leumi: 0.7,  undecided: 0.5 },
  mechina_army:          { full_time_torah: 0.35, torah_with_work: 0.65, academic_studies: 0.55, professional_training: 0.55, working: 0.55, military_career: 0.85, entrepreneurial: 0.5,  hesder: 0.8,  mechina_army: 1.0,  sherut_leumi: 0.75, undecided: 0.45 },
  sherut_leumi:          { full_time_torah: 0.3,  torah_with_work: 0.6,  academic_studies: 0.65, professional_training: 0.6,  working: 0.6,  military_career: 0.75, entrepreneurial: 0.55, hesder: 0.7,  mechina_army: 0.75, sherut_leumi: 1.0,  undecided: 0.45 },
  undecided:             { full_time_torah: 0.5,  torah_with_work: 0.55, academic_studies: 0.6,  professional_training: 0.6,  working: 0.55, military_career: 0.4,  entrepreneurial: 0.55, hesder: 0.5,  mechina_army: 0.45, sherut_leumi: 0.45, undecided: 0.7 },
};

// ── Lifestyle-tone closeness ──────────────────────────────

export const LIFESTYLE_CLOSENESS: Record<string, Record<string, ClosenessValue>> = {
  very_strict: { very_strict: 1.0, strict: 0.8,  moderate: 0.45, relaxed: 0.2,  flexible: 0.1  },
  strict:      { very_strict: 0.8, strict: 1.0,  moderate: 0.7,  relaxed: 0.4,  flexible: 0.25 },
  moderate:    { very_strict: 0.45, strict: 0.7,  moderate: 1.0,  relaxed: 0.75, flexible: 0.55 },
  relaxed:     { very_strict: 0.2, strict: 0.4,  moderate: 0.75, relaxed: 1.0,  flexible: 0.85 },
  flexible:    { very_strict: 0.1, strict: 0.25, moderate: 0.55, relaxed: 0.85, flexible: 1.0  },
};

// ══════════════════════════════════════════════════════════
// Sector / Sub-sector closeness matrix
//
// This is the most nuanced matrix. Key design decisions:
//
// 1. Sectors within the same broad "family" (e.g., dati_leumi variants)
//    have high closeness (0.7-0.95).
// 2. Cross-family sectors that share practical overlap (e.g., hardal ↔
//    dati_leumi_torani) still have meaningful closeness (0.5-0.7).
// 3. Distant sectors (e.g., haredi_hasidic ↔ dati_leumi_open) have low
//    but non-zero closeness (0.1-0.25) — they are NOT hard-blocked.
// 4. In discovery mode, closeness values below 0.3 still allow matches
//    but produce risk flags.
// ══════════════════════════════════════════════════════════

export const SECTOR_GROUP_CLOSENESS: Record<string, Record<string, ClosenessValue>> = {
  dati_leumi: { dati_leumi: 1.0,  haredi: 0.2,  dati: 0.7,  masorti: 0.5, hardal: 0.65, torani: 0.7, other: 0.3  },
  haredi:     { dati_leumi: 0.2,  haredi: 1.0,  dati: 0.4,  masorti: 0.1, hardal: 0.35, torani: 0.5, other: 0.15 },
  dati:       { dati_leumi: 0.7,  haredi: 0.4,  dati: 1.0,  masorti: 0.6, hardal: 0.55, torani: 0.65, other: 0.35 },
  masorti:    { dati_leumi: 0.5,  haredi: 0.1,  dati: 0.6,  masorti: 1.0, hardal: 0.25, torani: 0.35, other: 0.5  },
  hardal:     { dati_leumi: 0.65, haredi: 0.35, dati: 0.55, masorti: 0.25, hardal: 1.0, torani: 0.8, other: 0.2  },
  torani:     { dati_leumi: 0.7,  haredi: 0.5,  dati: 0.65, masorti: 0.35, hardal: 0.8, torani: 1.0, other: 0.25 },
  other:      { dati_leumi: 0.3,  haredi: 0.15, dati: 0.35, masorti: 0.5, hardal: 0.2, torani: 0.25, other: 1.0  },
};

export const SUB_SECTOR_CLOSENESS: Record<string, Record<string, ClosenessValue>> = {
  // ── Dati Leumi spectrum ──────────────────────
  dati_leumi_open:    { dati_leumi_open: 1.0, dati_leumi_classic: 0.8, dati_leumi_torani: 0.55, haredi_litvish: 0.15, haredi_hasidic: 0.1,  haredi_sephardi: 0.2,  haredi_modern: 0.35, dati_lite: 0.7,  dati_classic: 0.65, hardal_classic: 0.35, hardal_open: 0.5,  other: 0.3 },
  dati_leumi_classic: { dati_leumi_open: 0.8, dati_leumi_classic: 1.0, dati_leumi_torani: 0.75, haredi_litvish: 0.2,  haredi_hasidic: 0.15, haredi_sephardi: 0.25, haredi_modern: 0.45, dati_lite: 0.55, dati_classic: 0.8,  hardal_classic: 0.55, hardal_open: 0.65, other: 0.25 },
  dati_leumi_torani:  { dati_leumi_open: 0.55, dati_leumi_classic: 0.75, dati_leumi_torani: 1.0, haredi_litvish: 0.35, haredi_hasidic: 0.2, haredi_sephardi: 0.35, haredi_modern: 0.55, dati_lite: 0.35, dati_classic: 0.65, hardal_classic: 0.75, hardal_open: 0.8,  other: 0.2 },

  // ── Haredi spectrum ──────────────────────────
  haredi_litvish:     { dati_leumi_open: 0.15, dati_leumi_classic: 0.2, dati_leumi_torani: 0.35, haredi_litvish: 1.0, haredi_hasidic: 0.6,  haredi_sephardi: 0.65, haredi_modern: 0.75, dati_lite: 0.1,  dati_classic: 0.3,  hardal_classic: 0.45, hardal_open: 0.35, other: 0.1 },
  haredi_hasidic:     { dati_leumi_open: 0.1,  dati_leumi_classic: 0.15, dati_leumi_torani: 0.2, haredi_litvish: 0.6, haredi_hasidic: 1.0,  haredi_sephardi: 0.55, haredi_modern: 0.5, dati_lite: 0.05, dati_classic: 0.2,  hardal_classic: 0.3,  hardal_open: 0.2,  other: 0.05 },
  haredi_sephardi:    { dati_leumi_open: 0.2,  dati_leumi_classic: 0.25, dati_leumi_torani: 0.35, haredi_litvish: 0.65, haredi_hasidic: 0.55, haredi_sephardi: 1.0, haredi_modern: 0.7, dati_lite: 0.2,  dati_classic: 0.4,  hardal_classic: 0.45, hardal_open: 0.35, other: 0.15 },
  haredi_modern:      { dati_leumi_open: 0.35, dati_leumi_classic: 0.45, dati_leumi_torani: 0.55, haredi_litvish: 0.75, haredi_hasidic: 0.5, haredi_sephardi: 0.7, haredi_modern: 1.0, dati_lite: 0.3,  dati_classic: 0.5,  hardal_classic: 0.6,  hardal_open: 0.55, other: 0.2 },

  // ── Dati spectrum ────────────────────────────
  dati_lite:          { dati_leumi_open: 0.7,  dati_leumi_classic: 0.55, dati_leumi_torani: 0.35, haredi_litvish: 0.1, haredi_hasidic: 0.05, haredi_sephardi: 0.2, haredi_modern: 0.3, dati_lite: 1.0,  dati_classic: 0.75, hardal_classic: 0.2,  hardal_open: 0.35, other: 0.45 },
  dati_classic:       { dati_leumi_open: 0.65, dati_leumi_classic: 0.8, dati_leumi_torani: 0.65, haredi_litvish: 0.3, haredi_hasidic: 0.2, haredi_sephardi: 0.4, haredi_modern: 0.5, dati_lite: 0.75, dati_classic: 1.0,  hardal_classic: 0.5,  hardal_open: 0.6,  other: 0.3 },

  // ── Hardal spectrum ──────────────────────────
  hardal_classic:     { dati_leumi_open: 0.35, dati_leumi_classic: 0.55, dati_leumi_torani: 0.75, haredi_litvish: 0.45, haredi_hasidic: 0.3, haredi_sephardi: 0.45, haredi_modern: 0.6, dati_lite: 0.2,  dati_classic: 0.5,  hardal_classic: 1.0,  hardal_open: 0.85, other: 0.15 },
  hardal_open:        { dati_leumi_open: 0.5,  dati_leumi_classic: 0.65, dati_leumi_torani: 0.8, haredi_litvish: 0.35, haredi_hasidic: 0.2, haredi_sephardi: 0.35, haredi_modern: 0.55, dati_lite: 0.35, dati_classic: 0.6,  hardal_classic: 0.85, hardal_open: 1.0,  other: 0.2 },

  // ── Other ────────────────────────────────────
  other:              { dati_leumi_open: 0.3,  dati_leumi_classic: 0.25, dati_leumi_torani: 0.2, haredi_litvish: 0.1, haredi_hasidic: 0.05, haredi_sephardi: 0.15, haredi_modern: 0.2, dati_lite: 0.45, dati_classic: 0.3,  hardal_classic: 0.15, hardal_open: 0.2,  other: 1.0 },
};

// ── Sector closeness risk thresholds ──────────────────────

export const SECTOR_RISK = {
  /** Below this closeness → flagged as risk */
  RISK_THRESHOLD: 0.3,
  /** Below this closeness → high risk */
  HIGH_RISK_THRESHOLD: 0.15,
} as const;

// ── Override thresholds ───────────────────────────────────

export const OVERRIDE = {
  /** Max years beyond age preference to still consider with override */
  AGE_OVERRIDE_MAX_YEARS: 3,
  /** Minimum lifestyle closeness to override sector gap */
  LIFESTYLE_OVERRIDES_SECTOR_MIN: 0.7,
  /** Second-chapter: divorced/widowed candidates get relaxed scoring */
  SECOND_CHAPTER_AGE_BONUS_YEARS: 5,
  SECOND_CHAPTER_SECTOR_CLOSENESS_BONUS: 0.1,
} as const;
