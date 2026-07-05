import { api, getAuthHeaders } from './client';
import { ApiError, type ApiEnvelope } from '@/types/api';
import type { InternalCandidate, ExternalCandidate, ReadinessDetails, MatchSuggestion, Conversation } from '@/types/domain';

// Raw image upload — bypasses the JSON api client to send the file bytes
// with an image/* content-type (the server route uses express.raw). Auth
// header is attached exactly like every other request.
async function uploadCandidatePhoto(path: string, file: File): Promise<InternalCandidate> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': file.type },
    body: file,
  });
  let envelope: ApiEnvelope<InternalCandidate>;
  try {
    envelope = (await res.json()) as ApiEnvelope<InternalCandidate>;
  } catch {
    throw new ApiError(res.status, 'parse_error', 'Invalid JSON response');
  }
  if (!res.ok || !envelope.success) {
    throw new ApiError(
      res.status,
      envelope.error?.code ?? 'upload_failed',
      envelope.error?.message ?? 'העלאת התמונה נכשלה',
    );
  }
  return envelope.data as InternalCandidate;
}

// ── Source card ("כרטיס מקורי") ──────────────────────────
// The original WhatsApp message(s) a profile was extracted from — the raw
// "card" the AI received. Internal candidates are created manually, so
// hasSource is false and the tab shows a "no details" state.

export interface SourceCardMessage {
  _id: string;
  contentType: string;
  body?: string;
  mediaUrl?: string;
  mediaCaption?: string;
  senderName?: string;
  senderPhone?: string;
  chatJid?: string;
  createdAt: string;
}

export interface SourceCard {
  hasSource: boolean;
  sourceType?: string;
  sourceName?: string;
  sourceGroupName?: string;
  sourceSenderName?: string;
  sourceSenderPhone?: string;
  sourceImportedAt?: string;
  lastSourceUpdateAt?: string;
  messages: SourceCardMessage[];
  rawText?: string;
}

// ── Learned insight ("מה למדנו") ─────────────────────────
// What the learning agent derived from the candidate's suggestion
// history — real preferences beyond the static profile.

export interface CandidateInsight {
  candidateId: string;
  summary: string;
  positiveSignals: string[];
  negativeSignals: string[];
  guidance: string[];
  confidence: number;
  basedOnSuggestions: number;
  lastActivityAt?: string;
  learningModel?: string;
  createdAt: string;
  updatedAt: string;
}

export type CandidateInsightRebuildResult =
  | CandidateInsight
  | { rebuilt: false; reason: string };

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
  sourceCard: (id: string) => api.get<SourceCard>(`/candidates/internal/${id}/source-card`),
  uploadPhoto: (id: string, file: File) =>
    uploadCandidatePhoto(`/candidates/internal/${id}/photo`, file),
  insight: (id: string) => api.get<CandidateInsight | null>(`/candidates/internal/${id}/insight`),
  rebuildInsight: (id: string) =>
    api.post<CandidateInsightRebuildResult>(`/candidates/internal/${id}/insight/rebuild`),
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
  sourceCard: (id: string) => api.get<SourceCard>(`/candidates/external/${id}/source-card`),
};
