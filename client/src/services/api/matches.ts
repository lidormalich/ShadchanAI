import { api } from './client';
import type { MatchSuggestion, SendPreview } from '@/types/domain';

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

export const matchesApi = {
  list: (query: Record<string, unknown> = {}) =>
    api.get<MatchSuggestion[]>('/matches', query),
  get: (id: string) => api.get<MatchSuggestion>(`/matches/${id}`),
  evaluate: (body: { internalCandidateId: string; externalCandidateId: string; mode?: string }) =>
    api.post<MatchSuggestion>('/matches/evaluate', body),
  findForInternal: (internalId: string, query: { mode?: string; limit?: number } = {}) =>
    api.get<FindMatchItem[]>(`/matches/find-for/${internalId}`, query),
  createManual: (body: { internalCandidateId: string; externalCandidateId: string; mode?: string }) =>
    api.post<MatchSuggestion>('/matches', body),
  approve: (id: string) => api.post<MatchSuggestion>(`/matches/${id}/approve`),
  decline: (id: string, body: { side: 'a' | 'b'; reason?: string; notes?: string }) =>
    api.post<MatchSuggestion>(`/matches/${id}/decline`, body),
  defer: (id: string, body: { reason: string }) =>
    api.post<MatchSuggestion>(`/matches/${id}/defer`, body),
  reopenDeferred: (id: string) => api.post<MatchSuggestion>(`/matches/${id}/reopen-deferred`),
  markDating: (id: string) => api.post<MatchSuggestion>(`/matches/${id}/mark-dating`),
  close: (id: string, body: { reason: string }) =>
    api.post<MatchSuggestion>(`/matches/${id}/close`, body),
  explanation: (id: string) => api.get<Record<string, unknown>>(`/matches/${id}/explanation`),
  sendPreview: (id: string) => api.get<SendPreview>(`/matches/${id}/send-preview`),
  sendProposal: (id: string, body: { side: 'a' | 'b'; channelId: string; body: string }) =>
    api.post<{ messageId: string; externalMessageId: string; conversationId: string; matchStatus: string }>(
      `/matches/${id}/send-proposal`, body,
    ),
};
