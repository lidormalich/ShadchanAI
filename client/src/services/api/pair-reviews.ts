import { api } from './client';
import type { BlockerReason } from '@/types/domain';

// ── Types (mirror server/src/modules/pair-reviews) ───────────

export type PairReviewStatus =
  | 'suitable'
  | 'not_suitable'
  | 'review_later'
  | 'forced'
  | 'rejected_after_contact';

export interface PairReviewHistoryEntry {
  status: PairReviewStatus;
  reason?: string;
  reviewedBy: string;
  reviewedAt: string;
}

export interface PairReviewAIExplanation {
  text?: string;
  strengths?: string[];
  concerns?: string[];
  // Documented reasons this pair is NOT a good match ("למה לא מתאים").
  notMatchReasons?: string[];
  generatedAt?: string;
  provider?: string;
  model?: string;
}

export interface PairReview {
  _id: string;
  internalCandidateId: string;
  externalCandidateId: string;
  manualStatus: PairReviewStatus;
  operatorReason?: string;
  outcomeReason?: string;
  matchSuggestionId?: string;
  reviewedBy: string;
  reviewedAt: string;
  history: PairReviewHistoryEntry[];
  aiExplanation?: PairReviewAIExplanation;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPairReviewBody {
  manualStatus: PairReviewStatus;
  operatorReason?: string;
  outcomeReason?: string;
  matchSuggestionId?: string;
}

export interface AIExplainPairResponse {
  pairReview: PairReview;
  ai: {
    summary: string;
    strengths: string[];
    concerns: string[];
    nuance: string;
    recommendedApproach: string;
    notMatchReasons: string[];
  };
  metadata: {
    provider: string;
    model: string;
    fallbackUsed: boolean;
    cached: boolean;
    latencyMs: number;
  };
}

// ── Compatibility board types (server: compatibility.service.ts) ─

export type CompatibilityBucket =
  | 'suitable'
  | 'blocked'
  | 'weak'
  | 'forced'
  | 'historical';

export interface DeterministicExplanation {
  primary: string;
  positives: string[];
  negatives: string[];
  warnings: string[];
  manualOverlay?: string;
}

export interface CompatibilityRow {
  externalCandidateId: string;
  bucket: CompatibilityBucket;
  firstName?: string;
  lastName?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  personalStatus?: string;
  availabilityStatus?: string;
  engineEligible: boolean;
  matchScore?: number;
  confidenceScore?: number;
  matchType?: string;
  riskLevel?: string;
  strengths: string[];
  attentionPoints: string[];
  blockers: BlockerReason[];
  forceability: 'none' | 'with_reason' | 'not_blocked';
  explanation: DeterministicExplanation;
  matchSuggestionId?: string;
  matchStatus?: string;
  forcedOverride?: boolean;
  matchClosedAt?: string;
  matchCloseReason?: string;
  sideAResponseStatus?: string;
  sideBResponseStatus?: string;
  datingStartedAt?: string;
  manualStatus?: PairReviewStatus;
  operatorReason?: string;
  outcomeReason?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewHistoryCount?: number;
  pairReviewId?: string;
  aiExplanation?: PairReviewAIExplanation;
}

export interface CompatibilityBoard {
  internalCandidateId: string;
  generatedAt: string;
  externalsConsidered: number;
  totals: Record<CompatibilityBucket, number>;
  rows: CompatibilityRow[];
}

export interface PairCheckResult {
  internalCandidateId: string;
  externalCandidateId: string;
  externalFound: boolean;
  external?: {
    firstName?: string;
    lastName?: string;
    age?: number;
    city?: string;
    sectorGroup?: string;
    personalStatus?: string;
    availabilityStatus?: string;
    status?: string;
  };
  engine?: {
    eligible: boolean;
    matchScore: number;
    confidenceScore: number;
    matchType: string;
    riskLevel: string;
    strengths: string[];
    attentionPoints: string[];
    blockers: BlockerReason[];
    scoreBreakdown: Array<{
      dimension: string;
      score: number;
      weight: number;
      weightedScore: number;
      detail?: string;
    }>;
    overrideReasons: string[];
    flexibilityOverrideApplied: boolean;
    recommendedAction: string;
  };
  forceability: 'none' | 'with_reason' | 'not_blocked';
  bucket: CompatibilityBucket;
  explanation: DeterministicExplanation;
  existingSuggestion?: {
    matchSuggestionId: string;
    status: string;
    forcedOverride: boolean;
    closedAt?: string;
    closeReason?: string;
  };
  pairReview?: {
    pairReviewId: string;
    manualStatus: PairReviewStatus;
    operatorReason?: string;
    outcomeReason?: string;
    reviewedAt: string;
    reviewedBy: string;
    historyCount: number;
    aiExplanation?: PairReviewAIExplanation;
  };
}

// ── API ─────────────────────────────────────────────────────

export const pairReviewsApi = {
  listForInternal: (internalId: string) =>
    api.get<PairReview[]>(`/pair-reviews/internal/${internalId}`),
  getForPair: (internalId: string, externalId: string) =>
    api.get<PairReview | null>(`/pair-reviews/pair/${internalId}/${externalId}`),
  upsert: (internalId: string, externalId: string, body: UpsertPairReviewBody) =>
    api.put<PairReview>(`/pair-reviews/pair/${internalId}/${externalId}`, body),
  clear: (internalId: string, externalId: string) =>
    api.del<{ cleared: true }>(`/pair-reviews/pair/${internalId}/${externalId}`),
  aiExplain: (internalId: string, externalId: string) =>
    api.post<AIExplainPairResponse>(`/pair-reviews/pair/${internalId}/${externalId}/ai-explain`),
};

// ── Reasons bank ("מאגר סיבות") ──────────────────────────────

export interface RejectionReason {
  _id: string;
  code: string;
  category: string;
  text: string;
  source: 'deterministic' | 'ai' | 'operator';
  usageCount: number;
  lastUsedAt: string;
  createdAt: string;
}

export const rejectionReasonsApi = {
  list: (query: { category?: string; limit?: number } = {}) =>
    api.get<RejectionReason[]>('/rejection-reasons', query),
};

export const compatibilityApi = {
  board: (internalId: string, query: { mode?: 'strict' | 'discovery'; limit?: number } = {}) =>
    api.get<CompatibilityBoard>(`/candidates/internal/${internalId}/compatibility`, query),
  pairCheck: (internalId: string, body: { externalCandidateId: string; mode?: 'strict' | 'discovery' }) =>
    api.post<PairCheckResult>(`/candidates/internal/${internalId}/pair-check`, body),
};

// ── Semantic matches ("הצעה חכמה" tab) ───────────────────────
// Mirrors server/src/services/embedding/semantic-match.service.ts +
// semantic-backfill.service.ts.

export interface SemanticMatchRow {
  externalCandidateId: string;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  personalStatus?: string;
  availabilityStatus?: string;
  similarity: number;
  /** Short "why similar" reason chips computed server-side (no AI). */
  highlights?: string[];
  matchScore?: number;
  engineEligible?: boolean;
}

export interface SemanticMatchesResult {
  enabled: boolean;
  internalCandidateId: string;
  internalEmbedded: boolean;
  generatedAt: string;
  coverage: {
    externalsConsidered: number;
    externalsEmbedded: number;
    /** Dropped from the pool: stored gender says opposite, but the free text reads as same-gender (mis-tagged data). */
    genderSuspectsExcluded?: number;
  };
  rows: SemanticMatchRow[];
}

export interface SemanticBackfillState {
  status: 'idle' | 'running' | 'done' | 'error';
  /** 'delta' = missing/stale vectors only; 'force' = full sweep of all active candidates. */
  mode?: 'delta' | 'force';
  progressCurrent: number;
  progressTotal: number;
  embedded: number;
  failed: number;
  /** Profiles with no embeddable text — cannot enter the vector space until data is added. */
  noContent?: number;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
}

export const semanticApi = {
  matches: (internalId: string, query: { limit?: number } = {}) =>
    api.get<SemanticMatchesResult>(`/candidates/internal/${internalId}/semantic-matches`, query),
  backfillStart: (body: { force?: boolean } = {}) =>
    api.post<SemanticBackfillState>('/matches/semantic-backfill', body),
  backfillState: () =>
    api.get<SemanticBackfillState>('/matches/semantic-backfill/state'),
};
