import { api } from './client';
import type { InternalCandidate, ExternalCandidate, ReadinessDetails, MatchSuggestion, Conversation } from '@/types/domain';

// ── Internal candidates ──────────────────────────────────

export const internalCandidatesApi = {
  list: (query: Record<string, unknown> = {}) =>
    api.get<InternalCandidate[]>('/candidates/internal', query),
  get: (id: string) => api.get<InternalCandidate>(`/candidates/internal/${id}`),
  create: (body: Partial<InternalCandidate>) =>
    api.post<InternalCandidate>('/candidates/internal', body),
  update: (id: string, body: Partial<InternalCandidate>) =>
    api.patch<InternalCandidate>(`/candidates/internal/${id}`, body),
  archive: (id: string) => api.post<void>(`/candidates/internal/${id}/archive`),
  close: (id: string, body: { reason: string; note?: string }) =>
    api.post<InternalCandidate>(`/candidates/internal/${id}/close`, body),
  markDating: (id: string, body: { partnerCandidateId: string; sourceMatchId?: string }) =>
    api.post<InternalCandidate>(`/candidates/internal/${id}/mark-dating`, body),
  reopen: (id: string, body: { fromDatingMatchId?: string; reason: string; note?: string }) =>
    api.post<InternalCandidate>(`/candidates/internal/${id}/reopen`, body),
  suggestions: (id: string, query: Record<string, unknown> = {}) =>
    api.get<MatchSuggestion[]>(`/candidates/internal/${id}/suggestions`, query),
  conversations: (id: string) =>
    api.get<Conversation[]>(`/candidates/internal/${id}/conversations`),
  readiness: (id: string) => api.get<ReadinessDetails>(`/candidates/internal/${id}/readiness`),
};

// ── External candidates ──────────────────────────────────

export const externalCandidatesApi = {
  list: (query: Record<string, unknown> = {}) =>
    api.get<ExternalCandidate[]>('/candidates/external', query),
  get: (id: string) => api.get<ExternalCandidate>(`/candidates/external/${id}`),
  create: (body: Partial<ExternalCandidate>) =>
    api.post<ExternalCandidate>('/candidates/external', body),
  update: (id: string, body: Partial<ExternalCandidate>) =>
    api.patch<ExternalCandidate>(`/candidates/external/${id}`, body),
  archive: (id: string) => api.post<void>(`/candidates/external/${id}/archive`),
  updateShareCard: (id: string, body: Record<string, unknown>) =>
    api.patch<ExternalCandidate>(`/candidates/external/${id}/share-card`, body),
  updateAvailability: (id: string, body: { availabilityStatus: string; staleReason?: string; confirmAvailable?: boolean }) =>
    api.patch<ExternalCandidate>(`/candidates/external/${id}/availability`, body),
  matchingInternals: (id: string, query: Record<string, unknown> = {}) =>
    api.get<unknown[]>(`/candidates/external/${id}/matching-internals`, query),
};
