import { api } from './client';

export interface ExtractionOutcome {
  status: 'pending' | 'skipped_not_profile' | 'skipped_template' | 'matched_existing' | 'created_new' | 'needs_review' | 'failed';
  method: 'regex' | 'ai' | 'manual';
  candidateId?: string;
  confidence: number;
  matchedFields: string[];
  failureReason?: string;
  matchResult?: 'exact' | 'strong' | 'weak' | 'none';
}

export type ReviewReason =
  | 'suspected_duplicate'
  | 'low_confidence'
  | 'no_identifier'
  | 'no_corroboration'
  | 'vision_image';

export interface SuspectedCandidate {
  id: string;
  firstName?: string;
  lastName?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  personalStatus?: string;
  contactPhone?: string;
}

export interface ReviewQueueItem {
  messageId: string;
  conversationId: string;
  channelId: string;
  accountDisplayName: string;
  body?: string;
  mediaUrl?: string;
  createdAt: string;
  extraction?: {
    status: string;
    method?: string;
    confidence?: number;
    failureReason?: string;
    matchedFields?: string[];
  };
  extractedFields: {
    firstName?: string;
    lastName?: string;
    gender?: string;
    age?: number;
    height?: number;
    city?: string;
    edah?: string;
    sectorGroup?: string;
    personalStatus?: string;
    occupation?: string;
    about?: string;
    whatSeeking?: string;
    seekingAgeMin?: number;
    seekingAgeMax?: number;
    contactPhones?: string[];
    family?: string;
    service?: string;
    yeshiva?: string;
    religiousLevelText?: string;
  };
  regexConfidence: number;
  reviewReason?: ReviewReason;
  suspectedCandidate?: SuspectedCandidate;
}

export type ExtractedProfileInput = ReviewQueueItem['extractedFields'];

export type IngestionDecision =
  | 'accepted'
  | 'ignored_assigned_ignore'
  | 'ignored_match_sending'
  | 'ignored_unmapped';

export interface IngestionLogItem {
  messageId: string;
  conversationId: string;
  channelId: string;
  accountDisplayName: string;
  body?: string;
  createdAt: string;
  ingestion?: {
    decision: IngestionDecision;
    effectiveRole?: string;
    decidedAt: string;
  };
  extractionStatus?: string;
}

export const extractionApi = {
  run: (messageId: string) =>
    api.post<ExtractionOutcome>(`/extraction/messages/${messageId}/run`),
  reviewQueue: (limit = 50) =>
    api.get<ReviewQueueItem[]>('/extraction/review-queue', { limit }),
  ingestionLog: (decision: IngestionDecision | 'ignored' | 'all' = 'ignored', limit = 100) =>
    api.get<IngestionLogItem[]>('/extraction/ingestion-log', { decision, limit }),
  approve: (messageId: string, opts: { profile?: ExtractedProfileInput; linkToCandidateId?: string } = {}) =>
    api.post<{ candidateId: string; messageId: string; linked?: boolean }>(
      `/extraction/messages/${messageId}/approve`,
      opts.profile || opts.linkToCandidateId
        ? { profile: opts.profile, linkToCandidateId: opts.linkToCandidateId }
        : undefined,
    ),
  reject: (messageId: string) =>
    api.post<{ messageId: string; status: string }>(`/extraction/messages/${messageId}/reject`),
  refreshAll: () =>
    api.post<{ photosScanned: number; photosAttached: number; semanticStarted: boolean }>(
      '/extraction/refresh-all',
    ),
};
