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
  /** Lines the deterministic parser could not attach to a known label —
   *  candidates for the operator to teach as new label→field mappings. */
  unmatchedLines?: string[];
  /** Other cards currently in the queue that look like the SAME person (same
   *  first name + age/phone/city). Lets the operator merge same-person reposts
   *  even when none is a candidate yet. */
  pendingDuplicates?: {
    messageId: string;
    firstName?: string;
    lastName?: string;
    age?: number;
    city?: string;
    contactPhone?: string;
  }[];
}

// Canonical parser field keys an operator can map a label to (Feature C).
// 'other' = keep as general info (NOT scored/matched); 'ignore' = recognized
// then dropped (stops showing as an unknown label).
export type CardLabelField =
  | 'name' | 'age' | 'height' | 'city' | 'edah' | 'sector' | 'status'
  | 'occupation' | 'about' | 'family' | 'service' | 'yeshiva' | 'seeking'
  | 'ageRange' | 'maxAge' | 'photos' | 'phone'
  | 'other' | 'ignore';

export interface CardLabel {
  _id: string;
  label: string;
  field: CardLabelField;
  createdAt: string;
}

export interface CardAnalysis {
  recognizedFields: string[];
  unknownLabels: { label: string; value: string; suggestedField: CardLabelField | null }[];
}

export type ExtractedProfileInput = ReviewQueueItem['extractedFields'];

export type IngestionDecision =
  | 'accepted'
  | 'ignored_assigned_ignore'
  | 'ignored_match_sending'
  | 'ignored_unmapped';

export interface FailedQueueItem {
  messageId: string;
  conversationId: string;
  channelId: string;
  accountDisplayName: string;
  body?: string;
  mediaUrl?: string;
  createdAt: string;
  /** How many times the extraction fell before giving up. */
  retryCount: number;
  failureReason?: string;
  attemptedAt?: string;
  completedAt?: string;
}

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
  failedQueue: (limit = 100) =>
    api.get<FailedQueueItem[]>('/extraction/failed-queue', { limit }),
  requeue: (messageId: string) =>
    api.post<{ messageId: string; queued: boolean }>(`/extraction/messages/${messageId}/requeue`),
  requeueAllFailed: () =>
    api.post<{ requeued: number }>('/extraction/requeue-all-failed'),
  reprocessNeedsReview: () =>
    api.post<{ requeued: number }>('/extraction/reprocess-needs-review'),
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
  // Card-label dictionary — teach the parser new formats (Feature C).
  listCardLabels: () => api.get<CardLabel[]>('/extraction/card-labels'),
  addCardLabel: (label: string, field: CardLabelField) =>
    api.post<CardLabel>('/extraction/card-labels', { label, field }),
  deleteCardLabel: (id: string) =>
    api.del<{ deleted: boolean }>(`/extraction/card-labels/${id}`),
  analyzeCard: (text: string) =>
    api.post<CardAnalysis>('/extraction/card-labels/analyze', { text }),
  addCardLabelsBulk: (mappings: { label: string; field: CardLabelField }[]) =>
    api.post<{ created: number; skipped: number }>('/extraction/card-labels/bulk', { mappings }),
};
