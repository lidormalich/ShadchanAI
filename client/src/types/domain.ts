// ═══════════════════════════════════════════════════════════
// Frontend domain types — DTO-safe, mirrors backend model shapes
// (the subset the UI consumes). Enum values re-exported from shared.
// ═══════════════════════════════════════════════════════════

export type {
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
  ExternalSourceType,
  AvailabilityStatus,
  ClosureReason,
  MatchSuggestionStatus,
  MatchType,
  RiskLevel,
  SourceMode,
  RecommendedAction,
  SendStrategy,
  ChannelRole,
  ChannelProvider,
  ChannelStatus,
  WebhookStatus,
  ConversationPurpose,
  MessageDirection,
  MessageContentType,
  MessageDeliveryStatus,
  TaskStatus,
  TaskPriority,
  TaskType,
  NoteEntityType,
  NoteVisibility,
  ShareCardPhotoMode,
  AgeConfidence,
  ScoringDimension,
} from '@shadchanai/shared';

// ── Internal Candidate (UI shape) ────────────────────────
// (Phase 3) ownerUserId present on candidates/matches/tasks once
// they were created under the new schema. Older rows may lack it
// and render as "לא שויך" in the UI.
export interface InternalCandidate {
  _id: string;
  firstName: string;
  lastName: string;
  gender: string;
  dateOfBirth: string;
  hebrewName?: string;
  phone?: string;
  email?: string;
  photoUrl?: string;
  photoApproved?: boolean;
  city?: string;
  neighborhood?: string;
  sectorGroup: string;
  subSector?: string;
  lifestyleTone?: string;
  religiousStyle?: string;
  personalStatus: string;
  numberOfChildren: number;
  lifeStage?: string;
  readinessForMarriage: string;
  studyWorkDirection?: string;
  about?: string;
  whatSeeking?: string;
  referenceName?: string;
  openness?: {
    openToOtherSectors?: boolean;
    openToConverts?: boolean;
    openToDivorced?: boolean;
    openToWithChildren?: boolean;
    openToAgeDifference?: boolean;
    openToLongDistance?: boolean;
  };
  profileCompletion: number;
  missingCriticalFields: string[];
  sendReadinessBlockers: string[];
  profileQualityScore?: number;
  dataReliabilityScore?: number;
  readinessScore?: number;
  lastVerifiedAt?: string;
  lastActionAt?: string;
  status: string;
  datingPartnerCandidateId?: string;
  datingStartedAt?: string;
  datingSourceMatchId?: string;
  deferredSuggestionsCount: number;
  closureReason?: string;
  closureNote?: string;
  closedAt?: string;
  archivedAt?: string;
  ownerUserId?: string;
  createdAt: string;
  updatedAt: string;
}

// ── External Candidate ───────────────────────────────────
export interface ExternalCandidate {
  _id: string;
  sourceType: string;
  sourceName?: string;
  sourceMatchmakerName?: string;
  sourceChannelId?: string;
  sourceImportedAt: string;
  lastSourceUpdateAt?: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  subSector?: string;
  lifestyleTone?: string;
  personalStatus?: string;
  lifeStage?: string;
  studyWorkDirection?: string;
  height?: number;
  about?: string;
  whatSeeking?: string;
  photoUrl?: string;
  sharePhoto?: boolean;
  shareCard: {
    title?: string;
    summary?: string;
    visibleFields?: string[];
    photoMode?: string;
    approvedForShare: boolean;
    lastReviewedAt?: string;
  };
  availabilityStatus: string;
  status: string;
  ageReliability?: {
    reportedAgeAt?: string;
    ageConfidence?: string;
    approximateBirthYear?: number;
  };
  // Bidirectional preferences (OPTIONAL — set when source provides them)
  hardConstraints?: Array<{ field: string; operator: string; value: unknown; reason?: string }>;
  softPreferences?: Array<{ field: string; value: unknown; importance: string; note?: string }>;
  agePreferences?: { min?: number; max?: number; flexibility?: string };
  locationPreferences?: { cities?: string[]; regions?: string[]; willingToRelocate?: boolean; maxDistanceKm?: number };
  openness?: {
    openToOtherSectors?: boolean;
    openToConverts?: boolean;
    openToDivorced?: boolean;
    openToWithChildren?: boolean;
    openToAgeDifference?: boolean;
    openToLongDistance?: boolean;
  };
  staleAt?: string;
  staleReason?: string;
  lastConfirmedAvailableAt?: string;
  archivedAt?: string;
  ownerUserId?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Match Suggestion ─────────────────────────────────────
export interface ScoreDimensionView {
  dimension: string;
  score: number;
  weight: number;
  weightedScore: number;
  detail?: string;
}

export interface MatchSuggestion {
  _id: string;
  internalCandidateId: string;
  externalCandidateId: string;
  eligible: boolean;
  status: string;
  matchScore: number;
  confidenceScore: number;
  matchType: string;
  riskLevel: string;
  scoreBreakdown: ScoreDimensionView[];
  hardBlockers: string[];
  strengths: string[];
  attentionPoints: string[];
  overrideReasons: string[];
  flexibilityOverrideApplied: boolean;
  recommendedAction: string;
  sendStrategy: string;
  sourceMode: string;
  penalties: {
    historyPenalty: number;
    stalePenalty: number;
    timingPenalty: number;
    loadPenalty: number;
    totalPenalty: number;
  };
  semanticSimilarityScore?: number;
  isDeferred: boolean;
  deferredAt?: string;
  deferredReason?: string;
  reopenedFromDeferredAt?: string;
  datingStartedAt?: string;
  closedAt?: string;
  closeReason?: string;
  sideAResponse?: { status: string; respondedAt?: string; declineReason?: string; notes?: string; acknowledgedAt?: string; acknowledgedBy?: string };
  sideBResponse?: { status: string; respondedAt?: string; declineReason?: string; notes?: string; acknowledgedAt?: string; acknowledgedBy?: string };
  aiExplanation?: {
    text?: string;
    strengths?: string[];
    concerns?: string[];
    generatedAt?: string;
  };
  drafts?: {
    sideA?: { body: string; updatedAt?: string; source?: 'ai' | 'manual' };
    sideB?: { body: string; updatedAt?: string; source?: 'ai' | 'manual' };
  };
  conversationIds?: {
    sideA?: string;
    sideB?: string;
  };
  ownerUserId?: string;
  blockers?: BlockerReason[];
  forcedOverride?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BlockerReason {
  code: string;
  severity: 'hard_non_overridable' | 'hard_overridable' | 'soft_warning';
  overridable: 'none' | 'with_reason' | 'auto';
  message: string;
  detail?: Record<string, unknown>;
}

export interface BlockedMatchItem {
  externalCandidateId: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  age?: number;
  sectorGroup?: string;
  blockers: BlockerReason[];
  aggregateOverridable: 'none' | 'with_reason';
}

// ── Conversation / Message ───────────────────────────────
export interface Conversation {
  _id: string;
  channelId: string;
  channelRole: string;
  accountDisplayName: string;
  participantName?: string;
  participantPhone?: string;
  internalCandidateId?: string;
  externalCandidateId?: string;
  matchSuggestionId?: string;
  purpose: string;
  // Pre-pilot per-conversation role override. The authoritative
  // gate the ingestion pipeline reads.
  assignedRole?: 'profiles_source' | 'match_sending' | 'ignore';
  assignedRoleAt?: string;
  assignedRoleBy?: string;
  isActive: boolean;
  needsAction: boolean;
  unreadCount: number;
  lastMessageAt?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  supersedesConversationId?: string;
  replacedChannelOriginId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  _id: string;
  conversationId: string;
  channelId: string;
  channelRole: string;
  accountDisplayName: string;
  direction: string;
  contentType: string;
  body?: string;
  mediaCaption?: string;
  mediaMimeType?: string;
  deliveryStatus: string;
  sentAt?: string;
  deliveredAt?: string;
  readAt?: string;
  failedAt?: string;
  failureReason?: string;
  extraction?: {
    status: 'pending' | 'skipped_not_profile' | 'skipped_template' | 'matched_existing' | 'created_new' | 'needs_review' | 'failed';
    method?: 'regex' | 'ai' | 'manual';
    attemptedAt?: string;
    completedAt?: string;
    candidateId?: string;
    confidence?: number;
    failureReason?: string;
    matchedFields?: string[];
  };
  createdAt: string;
  updatedAt: string;
}

// ── Channel ──────────────────────────────────────────────
export interface Channel {
  channelId: string;
  role: string;
  accountDisplayName: string;
  phoneNumber: string;
  provider: string;
  providerSessionId?: string;
  status: string;
  statusReason?: string;
  connectionHealth: 'healthy' | 'degraded' | 'down';
  webhookStatus: string;
  lastConnectedAt?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  replacesChannelId?: string;
  replacedByChannelId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BaileysChannelStatus {
  channelId: string;
  state: 'idle' | 'connecting' | 'pending_pairing' | 'connected' | 'reconnecting' | 'disconnected' | 'logged_out';
  qr?: string;
  lastError?: string;
  lastConnectedAt?: string;
}

// ── Task ─────────────────────────────────────────────────
export interface Task {
  _id: string;
  type: string;
  title: string;
  description?: string;
  internalCandidateId?: string;
  externalCandidateId?: string;
  matchSuggestionId?: string;
  conversationId?: string;
  ownerUserId: string;
  assignedTo?: string;
  priority: string;
  dueAt?: string;
  status: string;
  completedAt?: string;
  completedBy?: string;
  completionNote?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Note ─────────────────────────────────────────────────
export interface Note {
  _id: string;
  entityType: string;
  entityId: string;
  body: string;
  authorUserId: string;
  mentions: string[];
  visibility: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Ask AI ───────────────────────────────────────────────
export interface AskAIResult {
  intent: string;
  appliedFilters: Record<string, unknown>;
  results: unknown[];
  reasoningSummary: string;
  recommendedActions: string[];
  warnings: string[];
}

export interface ReadinessDetails {
  profileCompletion: number;
  missingCriticalFields: string[];
  sendReadinessBlockers: string[];
}

export interface SendPreview {
  matchId: string;
  canSend: boolean;
  blockers: string[];
  internalCandidateReadiness: ReadinessDetails;
  externalCandidateAvailable: boolean;
  engineRecommendedAction: string;
}
