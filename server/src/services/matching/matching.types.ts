// ═══════════════════════════════════════════════════════════
// ShadchanAI — Matching Engine Types
//
// All interfaces consumed and produced by the deterministic
// matching engine. No Mongoose/DB types here — the engine
// operates on plain objects so it stays testable and portable.
// ═══════════════════════════════════════════════════════════

import type {
  Gender,
  SectorGroup,
  SubSector,
  LifestyleTone,
  ReligiousStyle,
  PersonalStatus,
  LifeStage,
  ReadinessForMarriage,
  StudyWorkDirection,
  CandidateStatus,
  ExternalCandidateStatus,
  AvailabilityStatus,
  MatchType,
  RiskLevel,
  SourceMode,
  ScoringDimension,
  AgeConfidence,
  ShareCardPhotoMode,
  BlockerCode,
  BlockerSeverity,
  BlockerOverridable,
  Region,
  ChildrenPreference,
  CareerPriority,
} from '@shadchanai/shared';

// ── Structured blocker reason ─────────────────────────────
// Emitted by matching.rules; consumed by the engine, API layer,
// and force-match validation path.
export interface BlockerReason {
  code: BlockerCode;
  severity: BlockerSeverity;
  overridable: BlockerOverridable;
  message: string;
  detail?: Record<string, unknown>;
}

// ── Engine Input: Internal Candidate (relevant subset) ────

export interface MatchableInternal {
  _id: string;
  firstName: string;
  lastName: string;
  gender: Gender;
  dateOfBirth: Date;

  // demographics
  city?: string;
  region?: Region;
  ethnicity?: string;
  height?: number;

  // shared goals (feed mutual_expectations; never hard-block)
  childrenPreference?: ChildrenPreference;
  careerPriority?: CareerPriority;

  // religious identity
  sectorGroup: SectorGroup;
  subSector?: SubSector;
  lifestyleTone?: LifestyleTone;
  religiousStyle?: ReligiousStyle;

  // personal
  personalStatus: PersonalStatus;
  numberOfChildren: number;
  lifeStage?: LifeStage;
  readinessForMarriage: ReadinessForMarriage;

  // direction
  studyWorkDirection?: StudyWorkDirection;

  // preferences
  hardConstraints: HardConstraint[];
  softPreferences: SoftPreference[];
  agePreferences?: AgePreference;
  locationPreferences?: LocationPreference;
  openness: OpennessFlags;

  // quality / readiness
  profileCompletion: number;
  missingCriticalFields: string[];
  sendReadinessBlockers: string[];
  profileQualityScore?: number;
  dataReliabilityScore?: number;
  readinessScore?: number;

  // status
  status: CandidateStatus;
  lastVerifiedAt?: Date;
  lastActionAt?: Date;

  // dating state
  datingPartnerCandidateId?: string;
  deferredSuggestionsCount: number;
}

// ── Engine Input: External Candidate (relevant subset) ────

export interface MatchableExternal {
  _id: string;
  firstName?: string;
  lastName?: string;
  gender?: Gender;
  age?: number;

  // demographics
  city?: string;
  region?: Region;
  ethnicity?: string;
  height?: number;

  // shared goals (optional — used when the source supplied them)
  childrenPreference?: ChildrenPreference;
  careerPriority?: CareerPriority;

  // religious identity
  sectorGroup?: SectorGroup;
  subSector?: SubSector;
  lifestyleTone?: LifestyleTone;

  // personal
  personalStatus?: PersonalStatus;
  lifeStage?: LifeStage;
  studyWorkDirection?: StudyWorkDirection;

  // availability
  availabilityStatus: AvailabilityStatus;
  status: ExternalCandidateStatus;

  // preferences (OPTIONAL — used for bidirectional matching).
  // When present, these are applied as hard rules + soft scoring
  // on the reverse direction ("external fits internal").
  hardConstraints?: HardConstraint[];
  softPreferences?: SoftPreference[];
  agePreferences?: AgePreference;
  locationPreferences?: LocationPreference;
  openness?: Partial<OpennessFlags>;

  // quality signals
  shareCard: {
    approvedForShare: boolean;
    photoMode?: ShareCardPhotoMode;
    lastReviewedAt?: Date;
  };
  ageReliability?: {
    reportedAgeAt?: Date;
    ageConfidence?: AgeConfidence;
    approximateBirthYear?: number;
  };

  // stale tracking
  staleAt?: Date;
  lastConfirmedAvailableAt?: Date;
  lastSourceUpdateAt?: Date;
  sourceImportedAt: Date;
}

// ── Preference sub-types ──────────────────────────────────

export interface HardConstraint {
  field: string;
  operator: 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'lt' | 'gte' | 'lte' | 'between';
  value: unknown;
  reason?: string;
}

export interface SoftPreference {
  field: string;
  value: unknown;
  importance: 'must_have' | 'important' | 'nice_to_have' | 'flexible';
  note?: string;
}

export interface AgePreference {
  min?: number;
  max?: number;
  flexibility?: 'strict' | 'somewhat_flexible' | 'very_flexible';
}

export interface LocationPreference {
  cities?: string[];
  regions?: string[];
  willingToRelocate?: boolean;
  maxDistanceKm?: number;
}

export interface OpennessFlags {
  openToOtherSectors: boolean;
  openToConverts: boolean;
  openToDivorced: boolean;
  openToWithChildren: boolean;
  openToAgeDifference: boolean;
  openToLongDistance: boolean;
}

// ── Engine Context (extra data passed to the engine) ──────

export interface MatchingContext {
  mode: SourceMode;

  /** IDs of external candidates with active (non-closed) suggestions for this internal candidate */
  activeMatchExternalIds: Set<string>;

  /** Pairs that were recently declined — maps `externalId` → decline date */
  recentDeclines: Map<string, Date>;

  /** How many active suggestions this internal candidate currently has */
  activeSuggestionCount: number;

  /** Optional semantic similarity score (0-1) from embeddings — not engine-computed */
  semanticSimilarities?: Map<string, number>;

  // ── Pattern-based penalty hooks (future extension) ──────
  // Populated by an upstream pattern-analysis service. The engine
  // only consumes these; it does not compute them. This keeps
  // pattern detection pluggable without changing engine logic.

  /** How many times internal has declined candidates with a profile similar to this external */
  similarProfileDeclineCount?: number;

  /** How many similar proposals this external candidate has received recently (external fatigue) */
  recentSimilarProposalCount?: number;

  /** How many proposals internal has received recently (internal fatigue) */
  recentProposalsReceivedByInternal?: number;
}

// ── Score Dimension Result ────────────────────────────────

export interface DimensionScore {
  dimension: ScoringDimension;
  score: number;      // 0-100
  weight: number;     // 0-1
  weightedScore: number;
  detail: string;     // human-readable explanation
}

// ── Penalties ─────────────────────────────────────────────

export interface Penalties {
  historyPenalty: number;
  stalePenalty: number;
  timingPenalty: number;
  loadPenalty: number;
  totalPenalty: number;
}

// ── Engine Output: Single Match Result ────────────────────

export interface MatchResult {
  internalCandidateId: string;
  externalCandidateId: string;

  eligible: boolean;
  // Legacy free-text list, retained so existing consumers (match doc
  // strengths/attention rendering, error messages) keep working.
  hardBlockers: string[];
  // Structured blocker details. Every entry in hardBlockers has a
  // corresponding entry here with code + severity + overridable.
  blockers: BlockerReason[];

  matchScore: number;         // 0-100 after penalties
  rawScore: number;           // 0-100 before penalties
  confidenceScore: number;    // 0-100
  matchType: MatchType;
  riskLevel: RiskLevel;

  scoreBreakdown: DimensionScore[];

  strengths: string[];
  attentionPoints: string[];
  overrideReasons: string[];
  flexibilityOverrideApplied: boolean;
  /**
   * Either side's stated age preference is violated beyond the ±tolerance.
   * Soft flag: the pair stays eligible and is still surfaced, but the UI
   * marks it as an out-of-range exception.
   */
  ageOutOfRange: boolean;

  recommendedAction: RecommendedAction;
  sendStrategy: SendStrategy;
  sourceMode: SourceMode;

  penalties: Penalties;

  semanticSimilarityScore?: number;
}

// ── Recommended Action (engine-level, more granular than shared enum) ──

export type RecommendedAction =
  | 'send_now'
  | 'send_side_a_first'
  | 'send_to_both'
  | 'auto_review_queue'
  | 'review_required'
  | 'hold_for_more_data'
  | 'wait'
  | 'skip';

export type SendStrategy =
  | 'side_a_first'
  | 'side_b_first'
  | 'both_simultaneously';

// ── Engine Configuration ──────────────────────────────────

export interface MatchingWeights {
  age: number;
  sector: number;
  lifestyle: number;
  study_work: number;
  location: number;
  mutual_expectations: number;
  life_stage: number;
  flexibility: number;
}

// ── Matrix types ──────────────────────────────────────────

/** 0-1 closeness value — 1 = identical, 0 = completely incompatible */
export type ClosenessValue = number;
