import { api } from './client';
import type { MatchSuggestion, SendPreview, BlockedMatchItem } from '@/types/domain';

export interface FindMatchItem {
  externalCandidateId: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  age?: number;
  sectorGroup?: string;
  matchScore: number;
  confidenceScore: number;
  matchType: 'safe' | 'balanced' | 'creative' | 'risky';
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  strengths: string[];
  attentionPoints: string[];
  recommendedAction: string;
}

export type ScanStatus = 'idle' | 'running' | 'done' | 'error';
export type ScanMode = 'missing' | 'incremental' | 'full';

export interface ScanState {
  status: ScanStatus;
  mode: ScanMode;
  running: boolean;
  progressCurrent: number;
  progressTotal: number;
  internalsConsidered: number;
  externalsConsidered: number;
  pairsScored: number;
  pairsSkipped: number;
  draftsCreated: number;
  improved: number;
  declined: number;
  durationMs: number;
  lastScanAt?: string;
  lastError?: string;
}

export interface ScanResultItem {
  internalCandidateId: string;
  externalCandidateId: string;
  internalName: string;
  externalName: string;
  matchScore: number;
  previousScore?: number;
  scoreDelta: number;
  scoreDirection: 'new' | 'up' | 'down' | 'same';
  confidenceScore: number;
  matchType: string;
  eligible: boolean;
  bucket: 'suitable' | 'weak' | 'blocked';
  matchSuggestionId?: string;
  autoCreated: boolean;
  scoredAt: string;
  // Short engine rationale: why the pair fits (strengths) and where the
  // gaps are (attentionPoints). Rendered as columns in the proposal inbox.
  strengths: string[];
  attentionPoints: string[];
  // Soft age-range exception: a stated age preference is violated beyond
  // ±1yr. The pair is still surfaced; the inbox marks it with a warning badge.
  ageOutOfRange?: boolean;
  // Operator reason recorded when held (review_later) or rejected (not_suitable).
  reviewReason?: string;
}

export interface MatchExplanationDTO {
  summary: string;
  strengths: string[];
  concerns: string[];
  nuance: string;
  recommendedApproach: string;
  notMatchReasons: string[];
  generatedAt?: string;
  provider?: string;
  model?: string;
}

export interface MatchExplanation {
  explanation: MatchExplanationDTO;
  // true when served from the persisted explanation (no AI call made).
  fromCache: boolean;
  // Labels of inputs that changed since the last generation (e.g.
  // "ציון ההתאמה"). Empty when served from cache or first-generated.
  changedFields: string[];
  // true when the fresh engine re-evaluation differed and the
  // suggestion's score/analysis fields were updated in place.
  rescored: boolean;
  // Engine score movement detected by the re-evaluation.
  score: {
    current: number;
    previous: number;
    delta: number;
    direction: 'up' | 'down' | 'same';
  };
}

// Advisory ⭐ insight-fit: whether an external candidate aligns with what
// the engine LEARNED about the internal candidate. Heuristic, never scores.
export type InsightFitTier = 'aligned' | 'conflict' | 'neutral';
export interface InsightFitResult {
  internalCandidateId: string;
  externalCandidateId: string;
  fit: { tier: InsightFitTier; reason?: string; confidence: number };
}

export const matchesApi = {
  list: (query: Record<string, unknown> = {}) =>
    api.get<MatchSuggestion[]>('/matches', query),
  scan: (body: { mode?: ScanMode } = {}) =>
    api.post<{ started: boolean; state: ScanState | null }>('/matches/scan', body),
  scanState: () => api.get<ScanState | null>('/matches/scan/state'),
  scanResults: (query: Record<string, unknown> = {}) =>
    api.get<ScanResultItem[]>('/matches/scan/results', query),
  get: (id: string) => api.get<MatchSuggestion>(`/matches/${id}`),
  evaluate: (body: { internalCandidateId: string; externalCandidateId: string; mode?: string }) =>
    api.post<MatchSuggestion>('/matches/evaluate', body),
  insightFit: (body: { pairs: Array<{ internalCandidateId: string; externalCandidateId: string }> }) =>
    api.post<InsightFitResult[]>('/matches/insight-fit', body),
  findForInternal: (internalId: string, query: { mode?: string; limit?: number } = {}) =>
    api.get<FindMatchItem[]>(`/matches/find-for/${internalId}`, query),
  findBlockedForInternal: (internalId: string, query: { mode?: string; limit?: number } = {}) =>
    api.get<BlockedMatchItem[]>(`/matches/find-for/${internalId}/blocked`, query),
  createManual: (body: { internalCandidateId: string; externalCandidateId: string; mode?: string }) =>
    api.post<MatchSuggestion>('/matches', body),
  force: (body: { internalCandidateId: string; externalCandidateId: string; mode?: string; justification: string }) =>
    api.post<MatchSuggestion>('/matches/force', body),
  approve: (id: string, body: { reason?: string } = {}) =>
    api.post<MatchSuggestion>(`/matches/${id}/approve`, body.reason ? { reason: body.reason } : undefined),
  decline: (id: string, body: { side: 'a' | 'b'; reason?: string; notes?: string }) =>
    api.post<MatchSuggestion>(`/matches/${id}/decline`, body),
  defer: (id: string, body: { reason: string }) =>
    api.post<MatchSuggestion>(`/matches/${id}/defer`, body),
  reopenDeferred: (id: string) => api.post<MatchSuggestion>(`/matches/${id}/reopen-deferred`),
  markDating: (id: string, body: { reason?: string } = {}) =>
    api.post<MatchSuggestion>(`/matches/${id}/mark-dating`, body.reason ? { reason: body.reason } : undefined),
  close: (
    id: string,
    body: { reason: string; closureReason?: string; sideAReason?: string; sideBReason?: string },
  ) => api.post<MatchSuggestion>(`/matches/${id}/close`, body),
  explanation: (id: string) => api.get<Record<string, unknown>>(`/matches/${id}/explanation`),
  explain: (id: string, body: { force?: boolean } = {}) =>
    api.post<MatchExplanation>(`/matches/${id}/explain`, body),
  sendPreview: (id: string) => api.get<SendPreview>(`/matches/${id}/send-preview`),
  saveDraft: (id: string, body: { side: 'a' | 'b'; body: string; source?: 'ai' | 'manual' }) =>
    api.patch<MatchSuggestion>(`/matches/${id}/draft`, body),
  acknowledgeResponse: (id: string, body: { side: 'a' | 'b' }) =>
    api.post<MatchSuggestion>(`/matches/${id}/acknowledge-response`, body),
  sendProposal: (id: string, body: { side: 'a' | 'b'; channelId: string; body: string }) =>
    api.post<{ messageId: string; externalMessageId: string; conversationId: string; matchStatus: string }>(
      `/matches/${id}/send-proposal`, body,
    ),
};
