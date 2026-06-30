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

export interface ReviewQueueItem {
  messageId: string;
  conversationId: string;
  channelId: string;
  accountDisplayName: string;
  body?: string;
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
  };
  regexConfidence: number;
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
  approve: (messageId: string, profile?: ExtractedProfileInput) =>
    api.post<{ candidateId: string; messageId: string }>(
      `/extraction/messages/${messageId}/approve`,
      profile ? { profile } : undefined,
    ),
  reject: (messageId: string) =>
    api.post<{ messageId: string; status: string }>(`/extraction/messages/${messageId}/reject`),
};
