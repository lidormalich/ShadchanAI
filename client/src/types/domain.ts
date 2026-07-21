// ═══════════════════════════════════════════════════════════
// Frontend domain types — DTO-safe, mirrors backend model shapes
// (the subset the UI consumes). Enum values re-exported from shared.
// ═══════════════════════════════════════════════════════════

import type {
  Gender,
  SectorGroup,
  SubSector,
  LifestyleTone,
  ReligiousStyle,
  PersonalStatus,
  LifeStage,
  ReadinessForMarriage,
  StudyWorkDirection,
  Region,
  ChildrenPreference,
  CareerPriority,
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
  gender: Gender;
  dateOfBirth: string;
  hebrewName?: string;
  phone?: string;
  email?: string;
  photoUrl?: string;
  photoApproved?: boolean;
  city?: string;
  region?: Region;
  neighborhood?: string;
  ethnicity?: string;
  familyBackground?: string;
  characterTraits?: string[];
  characterNotes?: string;
  lifeGoals?: {
    childrenPreference?: ChildrenPreference;
    careerPriority?: CareerPriority;
    homeVision?: string;
  };
  sectorGroup: SectorGroup;
  subSector?: SubSector;
  lifestyleTone?: LifestyleTone;
  religiousStyle?: ReligiousStyle;
  personalStatus: PersonalStatus;
  numberOfChildren: number;
  lifeStage?: LifeStage;
  readinessForMarriage: ReadinessForMarriage;
  studyWorkDirection?: StudyWorkDirection;
  currentOccupation?: string;
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
  status: CandidateStatus;
  datingPartnerCandidateId?: string;
  datingStartedAt?: string;
  datingSourceMatchId?: string;
  deferredSuggestionsCount: number;
  closureReason?: ClosureReason;
  closureNote?: string;
  closedAt?: string;
  archivedAt?: string;
  ownerUserId?: string;
  createdAt: string;
  updatedAt: string;
}

// ── External Candidate ───────────────────────────────────
// One entry in the candidate's accumulated phone list — every number the
// system has ever seen for them (card, merged duplicates, manual adds),
// each with an optional "who is this" label.
export interface CandidatePhone {
  number: string;
  normalized?: string;
  label?: string;
  source?: string;
}

export interface ExternalCandidate {
  _id: string;
  sourceType: ExternalSourceType;
  sourceName?: string;
  sourceMatchmakerName?: string;
  sourceChannelId?: string;
  // WhatsApp provenance: group + actual sender (poster).
  sourceChatJid?: string;
  sourceGroupName?: string;
  sourceSenderName?: string;
  sourceSenderPhone?: string;
  sourceImportedAt: string;
  lastSourceUpdateAt?: string;
  contactPhone?: string;
  phones?: CandidatePhone[];
  firstName?: string;
  lastName?: string;
  hebrewName?: string;
  fatherName?: string;
  motherName?: string;
  email?: string;
  gender?: Gender;
  age?: number;
  city?: string;
  region?: Region;
  neighborhood?: string;
  originCity?: string;
  originCountry?: string;
  ethnicity?: string;
  familyBackground?: string;
  sectorGroup?: SectorGroup;
  subSector?: SubSector;
  lifestyleTone?: LifestyleTone;
  religiousStyle?: ReligiousStyle;
  personalStatus?: PersonalStatus;
  numberOfChildren?: number;
  lifeStage?: LifeStage;
  readinessForMarriage?: ReadinessForMarriage;
  studyWorkDirection?: StudyWorkDirection;
  currentOccupation?: string;
  educationLevel?: string;
  educationInstitution?: string;
  torahStudyYears?: number;
  armyService?: string;
  characterTraits?: string[];
  characterNotes?: string;
  lifeGoals?: {
    childrenPreference?: ChildrenPreference;
    careerPriority?: CareerPriority;
    homeVision?: string;
  };
  height?: number;
  about?: string;
  whatSeeking?: string;
  additionalInfo?: string;
  referenceName?: string;
  referencePhone?: string;
  photoUrl?: string;
  sharePhoto?: boolean;
  shareCard: {
    title?: string;
    summary?: string;
    visibleFields?: string[];
    photoMode?: ShareCardPhotoMode;
    approvedForShare: boolean;
    lastReviewedAt?: string;
  };
  availabilityStatus: AvailabilityStatus;
  status: ExternalCandidateStatus;
  ageReliability?: {
    reportedAgeAt?: string;
    ageConfidence?: AgeConfidence;
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
  /** Operator marked the needs-details profile as "מולא" (all knowable fields filled). */
  detailsCompletedAt?: string;
  archivedAt?: string;
  ownerUserId?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Match Suggestion ─────────────────────────────────────
export interface ScoreDimensionView {
  dimension: ScoringDimension;
  score: number;
  weight: number;
  weightedScore: number;
  detail?: string;
}

export interface MatchSuggestion {
  _id: string;
  internalCandidateId: string;
  externalCandidateId: string;
  // Resolved candidate names (added by listMatches); optional for endpoints
  // that don't enrich.
  internalName?: string;
  externalName?: string;
  eligible: boolean;
  status: MatchSuggestionStatus;
  matchScore: number;
  confidenceScore: number;
  matchType: MatchType;
  riskLevel: RiskLevel;
  scoreBreakdown: ScoreDimensionView[];
  hardBlockers: string[];
  strengths: string[];
  attentionPoints: string[];
  overrideReasons: string[];
  flexibilityOverrideApplied: boolean;
  recommendedAction: RecommendedAction;
  sendStrategy: SendStrategy;
  sourceMode: SourceMode;
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
  // When each side's proposal was actually sent (undefined = never sent).
  sentSideAAt?: string;
  sentSideBAt?: string;
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
  sectorGroup?: SectorGroup;
  blockers: BlockerReason[];
  aggregateOverridable: 'none' | 'with_reason';
}

// ── Conversation / Message ───────────────────────────────
export interface Conversation {
  _id: string;
  channelId: string;
  channelRole: ChannelRole;
  accountDisplayName: string;
  participantName?: string;
  participantPhone?: string;
  internalCandidateId?: string;
  externalCandidateId?: string;
  matchSuggestionId?: string;
  purpose: ConversationPurpose;
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
  channelRole: ChannelRole;
  accountDisplayName: string;
  direction: MessageDirection;
  contentType: MessageContentType;
  body?: string;
  mediaCaption?: string;
  mediaMimeType?: string;
  deliveryStatus: MessageDeliveryStatus;
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
  role: ChannelRole;
  accountDisplayName: string;
  phoneNumber: string;
  provider: ChannelProvider;
  providerSessionId?: string;
  status: ChannelStatus;
  statusReason?: string;
  connectionHealth: 'healthy' | 'degraded' | 'down';
  webhookStatus: WebhookStatus;
  lastConnectedAt?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  replacesChannelId?: string;
  replacedByChannelId?: string;
  // Self-heal telemetry — set by the connection watchdog on auto-revival.
  lastAutoReconnectAt?: string;
  autoReconnectCount?: number;
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
  type: TaskType;
  title: string;
  description?: string;
  internalCandidateId?: string;
  externalCandidateId?: string;
  matchSuggestionId?: string;
  conversationId?: string;
  ownerUserId: string;
  assignedTo?: string;
  priority: TaskPriority;
  dueAt?: string;
  status: TaskStatus;
  completedAt?: string;
  completedBy?: string;
  completionNote?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Note ─────────────────────────────────────────────────
export interface Note {
  _id: string;
  entityType: NoteEntityType;
  entityId: string;
  body: string;
  authorUserId: string;
  mentions: string[];
  visibility: NoteVisibility;
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
  engineRecommendedAction: RecommendedAction;
}
