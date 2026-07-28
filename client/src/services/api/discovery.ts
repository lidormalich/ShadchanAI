// ═══════════════════════════════════════════════════════════
// Discovery ("היכרות חכמה") API — public swipe surface + operator
// session management.
//
// The public functions run with NO auth token (the session token in
// the path is the credential); apiRequest simply sends no
// Authorization header when none is stored.
// ═══════════════════════════════════════════════════════════

import { api } from './client';

// ── Shared shapes ────────────────────────────────────────

export interface DiscoveryCardDTO {
  cardId: string;
  age?: number;
  regionLabel?: string;
  sectorGroupLabel?: string;
  subSectorLabel?: string;
  personalStatusLabel?: string;
  occupation?: string;
  educationLevel?: string;
  height?: number;
  summary?: string;
  highlights: string[];
  hasPhoto: boolean;
}

export interface WizardQuestion {
  id: string;
  question: string;
  type: 'single' | 'multi' | 'range';
  mapsTo: string;
  options: Array<{ value: string; label: string }>;
}

export interface MeetWizard {
  source: 'ai' | 'static';
  questions: WizardQuestion[];
}

export interface MeetProgress {
  served: number;
  liked: number;
  rejected: number;
  remaining: number;
}

export type MeetGateState = 'ok' | 'invalid' | 'expired' | 'disabled';

export interface MeetState {
  state: MeetGateState;
  status?: string;
  step?: 'traits' | 'swiping' | 'done';
  firstName?: string;
  wizard?: MeetWizard;
  progress?: MeetProgress;
  currentBatch?: DiscoveryCardDTO[];
  rejectChips?: string[];
}

export interface MeetBatch {
  state: MeetGateState;
  batchIndex?: number;
  cards?: DiscoveryCardDTO[];
  exhausted?: boolean;
  refined?: boolean;
}

export interface TraitPicksPayload {
  ageMin?: number;
  ageMax?: number;
  regions?: string[];
  openness?: Record<string, boolean>;
  softPreferences?: Array<{ field: string; value: string; importance?: string }>;
  freeText?: string;
}

export interface MeetFinishResult {
  state: MeetGateState;
  status?: string;
  insights?: {
    liked: number;
    rejected: number;
    total: number;
    learnedSummary?: string;
    learnedSignals: string[];
  };
}

// ── Public (candidate-facing) ────────────────────────────

const PUB = '/public/discovery';

export async function getMeetState(token: string): Promise<MeetState> {
  const { data } = await api.get<MeetState>(`${PUB}/${token}`);
  return data;
}

export async function submitTraits(token: string, picks: TraitPicksPayload): Promise<{ state: MeetGateState; status?: string }> {
  const { data } = await api.post<{ state: MeetGateState; status?: string }>(`${PUB}/${token}/traits`, picks);
  return data;
}

export async function getNextBatch(token: string): Promise<MeetBatch> {
  const { data } = await api.post<MeetBatch>(`${PUB}/${token}/batch`);
  return data;
}

export async function submitVerdict(
  token: string,
  body: { cardId: string; verdict: 'like' | 'reject' | 'skip'; reasonChips?: string[]; reasonText?: string },
): Promise<{ state: MeetGateState; recorded: boolean; alreadyRecorded: boolean; batchComplete: boolean }> {
  const { data } = await api.post<{ state: MeetGateState; recorded: boolean; alreadyRecorded: boolean; batchComplete: boolean }>(
    `${PUB}/${token}/verdict`,
    body,
  );
  return data;
}

export async function finishMeet(token: string): Promise<MeetFinishResult> {
  const { data } = await api.post<MeetFinishResult>(`${PUB}/${token}/finish`);
  return data;
}

export function meetPhotoUrl(token: string, cardId: string): string {
  return `/api${PUB}/${token}/photo/${cardId}`;
}

// ── Operator (auth-gated) ────────────────────────────────

export interface DiscoverySessionRow {
  id: string;
  status: 'pending_traits' | 'active' | 'completed' | 'revoked' | 'expired';
  expiresAt: string;
  counters: { served: number; liked: number; rejected: number; skipped: number; aiCalls: number };
  createdAt: string;
  finishedAt?: string;
  pendingReview: boolean;
  url: string;
}

export interface DiscoverySessionDetail {
  id: string;
  internalCandidateId: string;
  status: DiscoverySessionRow['status'];
  expiresAt: string;
  createdAt: string;
  finishedAt?: string;
  counters: DiscoverySessionRow['counters'];
  wizard?: MeetWizard;
  traitPicks?: TraitPicksPayload;
  aiSummaries: Array<{
    round: number;
    summary: string;
    positiveSignals: string[];
    negativeSignals: string[];
    avoidFilters: Array<{ field: string; value: string }>;
    confidence: number;
    at: string;
  }>;
  cards: Array<{
    cardId: string;
    externalCandidateId: string;
    firstName?: string;
    lastName?: string;
    age?: number;
    city?: string;
    sectorGroup?: string;
    batchIndex: number;
    engineScore: number;
    verdict?: 'like' | 'reject' | 'skip';
    reasonChips?: string[];
    reasonText?: string;
    verdictAt?: string;
  }>;
  url: string;
}

export interface RevealedPreferenceRow {
  externalCandidateId: string;
  firstName?: string;
  lastName?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  personalStatus?: string;
  engineScore: number;
  prefSim?: number;
  finalRank: number;
  strengths: string[];
  candidateVerdict?: { verdict: 'like' | 'reject' | 'skip'; reasons: string[]; at?: string };
}

export interface RevealedPreferenceRanking {
  available: boolean;
  reason?: 'no_sessions' | 'no_verdicts';
  semanticActive: boolean;
  signals: { likes: number; rejects: number; hasAiSummary: boolean };
  learnedSummary?: string;
  positiveSignals: string[];
  negativeSignals: string[];
  rows: RevealedPreferenceRow[];
}

export async function getPreferenceRanking(internalCandidateId: string): Promise<RevealedPreferenceRanking> {
  const { data } = await api.get<RevealedPreferenceRanking>('/discovery/preference-ranking', { internalCandidateId });
  return data;
}

// ── Apply revealed preferences to the profile ────────────

export interface ProfileChange {
  key: string;
  label: string;
  currentDisplay: string;
  proposedDisplay: string;
}

export interface ProfileProposal {
  available: boolean;
  reason?: 'no_sessions' | 'no_changes';
  basedOn?: {
    sessionFinishedAt?: string;
    likes: number;
    rejects: number;
    learnedSummary?: string;
  };
  changes: ProfileChange[];
}

export async function getProfileProposal(internalCandidateId: string): Promise<ProfileProposal> {
  const { data } = await api.get<ProfileProposal>('/discovery/profile-proposal', { internalCandidateId });
  return data;
}

export async function applyProfileProposal(internalCandidateId: string, accept: string[]): Promise<{ applied: string[] }> {
  const { data } = await api.post<{ applied: string[] }>('/discovery/profile-proposal/apply', {
    internalCandidateId,
    accept,
  });
  return data;
}

export async function createDiscoverySession(internalCandidateId: string): Promise<{
  id: string; status: string; expiresAt: string; url: string;
}> {
  const { data } = await api.post<{ id: string; status: string; expiresAt: string; url: string }>(
    '/discovery/sessions',
    { internalCandidateId },
  );
  return data;
}

export async function listDiscoverySessions(internalCandidateId: string): Promise<DiscoverySessionRow[]> {
  const { data } = await api.get<DiscoverySessionRow[]>('/discovery/sessions', { internalCandidateId });
  return data;
}

export async function getDiscoverySession(id: string): Promise<DiscoverySessionDetail> {
  const { data } = await api.get<DiscoverySessionDetail>(`/discovery/sessions/${id}`);
  return data;
}

export async function revokeDiscoverySession(id: string): Promise<{ id: string; status: string }> {
  const { data } = await api.post<{ id: string; status: string }>(`/discovery/sessions/${id}/revoke`);
  return data;
}

export async function regenerateDiscoverySession(id: string): Promise<{
  id: string; status: string; expiresAt: string; url: string;
}> {
  const { data } = await api.post<{ id: string; status: string; expiresAt: string; url: string }>(
    `/discovery/sessions/${id}/regenerate`,
  );
  return data;
}
