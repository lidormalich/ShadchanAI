// ═══════════════════════════════════════════════════════════
// ShadchanAI — Shared Enums
// Single source of truth for all enum values across the stack.
// These are used in DTOs, API responses, and as Mongoose enum arrays.
// ═══════════════════════════════════════════════════════════

// ── Gender ────────────────────────────────────────────────
export const Gender = {
  MALE: 'male',
  FEMALE: 'female',
} as const;
export type Gender = (typeof Gender)[keyof typeof Gender];

// ── Sector Group ──────────────────────────────────────────
export const SectorGroup = {
  DATI_LEUMI: 'dati_leumi',
  HAREDI: 'haredi',
  DATI: 'dati',
  MASORTI: 'masorti',
  HARDAL: 'hardal',
  TORANI: 'torani',
  OTHER: 'other',
} as const;
export type SectorGroup = (typeof SectorGroup)[keyof typeof SectorGroup];

// ── Sub-Sector ────────────────────────────────────────────
export const SubSector = {
  // Dati Leumi spectrum
  DATI_LEUMI_OPEN: 'dati_leumi_open',
  DATI_LEUMI_CLASSIC: 'dati_leumi_classic',
  DATI_LEUMI_TORANI: 'dati_leumi_torani',
  // Haredi spectrum
  HAREDI_LITVISH: 'haredi_litvish',
  HAREDI_HASIDIC: 'haredi_hasidic',
  HAREDI_SEPHARDI: 'haredi_sephardi',
  HAREDI_MODERN: 'haredi_modern',
  // Dati spectrum
  DATI_LITE: 'dati_lite',
  DATI_CLASSIC: 'dati_classic',
  // Hardal
  HARDAL_CLASSIC: 'hardal_classic',
  HARDAL_OPEN: 'hardal_open',
  // Other
  OTHER: 'other',
} as const;
export type SubSector = (typeof SubSector)[keyof typeof SubSector];

// ── Lifestyle Tone ────────────────────────────────────────
export const LifestyleTone = {
  VERY_STRICT: 'very_strict',
  STRICT: 'strict',
  MODERATE: 'moderate',
  RELAXED: 'relaxed',
  FLEXIBLE: 'flexible',
} as const;
export type LifestyleTone = (typeof LifestyleTone)[keyof typeof LifestyleTone];

// ── Religious Style ───────────────────────────────────────
export const ReligiousStyle = {
  HALACHIC_STRICT: 'halachic_strict',
  HALACHIC_MAINSTREAM: 'halachic_mainstream',
  TRADITIONAL_OBSERVANT: 'traditional_observant',
  SPIRITUAL_FLEXIBLE: 'spiritual_flexible',
  CULTURAL: 'cultural',
} as const;
export type ReligiousStyle = (typeof ReligiousStyle)[keyof typeof ReligiousStyle];

// ── Personal Status ───────────────────────────────────────
export const PersonalStatus = {
  SINGLE: 'single',
  DIVORCED: 'divorced',
  WIDOWED: 'widowed',
  SEPARATED: 'separated',
} as const;
export type PersonalStatus = (typeof PersonalStatus)[keyof typeof PersonalStatus];

// ── Life Stage ────────────────────────────────────────────
export const LifeStage = {
  POST_HIGH_SCHOOL: 'post_high_school',
  NATIONAL_SERVICE: 'national_service',
  ARMY: 'army',
  YESHIVA_SEMINARY: 'yeshiva_seminary',
  EARLY_STUDIES: 'early_studies',
  MID_STUDIES: 'mid_studies',
  EARLY_CAREER: 'early_career',
  ESTABLISHED_CAREER: 'established_career',
  MATURE: 'mature',
} as const;
export type LifeStage = (typeof LifeStage)[keyof typeof LifeStage];

// ── Readiness for Marriage ────────────────────────────────
export const ReadinessForMarriage = {
  ACTIVELY_LOOKING: 'actively_looking',
  OPEN: 'open',
  EXPLORING: 'exploring',
  NOT_READY: 'not_ready',
  ON_HOLD: 'on_hold',
} as const;
export type ReadinessForMarriage = (typeof ReadinessForMarriage)[keyof typeof ReadinessForMarriage];

// ── Study-Work Direction ──────────────────────────────────
// Covers the full range of Israeli religious-life trajectories:
// full-time torah (kollel), torah+work, academic, professional,
// working, career military, entrepreneurial, hesder (yeshiva+army),
// mechina+army (pre-military religious academy), sherut leumi
// (national service), and undecided.
export const StudyWorkDirection = {
  FULL_TIME_TORAH: 'full_time_torah',
  TORAH_WITH_WORK: 'torah_with_work',
  ACADEMIC_STUDIES: 'academic_studies',
  PROFESSIONAL_TRAINING: 'professional_training',
  WORKING: 'working',
  MILITARY_CAREER: 'military_career',
  ENTREPRENEURIAL: 'entrepreneurial',
  HESDER: 'hesder',
  MECHINA_ARMY: 'mechina_army',
  SHERUT_LEUMI: 'sherut_leumi',
  UNDECIDED: 'undecided',
} as const;
export type StudyWorkDirection = (typeof StudyWorkDirection)[keyof typeof StudyWorkDirection];

// ── Candidate Status ──────────────────────────────────────
export const CandidateStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  DATING: 'dating',
  CLOSED: 'closed',
  ARCHIVED: 'archived',
} as const;
export type CandidateStatus = (typeof CandidateStatus)[keyof typeof CandidateStatus];

// ── External Candidate Status ─────────────────────────────
export const ExternalCandidateStatus = {
  ACTIVE: 'active',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
  ARCHIVED: 'archived',
} as const;
export type ExternalCandidateStatus = (typeof ExternalCandidateStatus)[keyof typeof ExternalCandidateStatus];

// ── External Source Type ──────────────────────────────────
export const ExternalSourceType = {
  WHATSAPP_GROUP: 'whatsapp_group',
  MATCHMAKER_REFERRAL: 'matchmaker_referral',
  WEBSITE: 'website',
  MANUAL_ENTRY: 'manual_entry',
  OTHER: 'other',
} as const;
export type ExternalSourceType = (typeof ExternalSourceType)[keyof typeof ExternalSourceType];

// ── Availability Status (external candidates) ─────────────
export const AvailabilityStatus = {
  AVAILABLE: 'available',
  DATING: 'dating',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
} as const;
export type AvailabilityStatus = (typeof AvailabilityStatus)[keyof typeof AvailabilityStatus];

// ── Closure Reason ────────────────────────────────────────
export const ClosureReason = {
  ENGAGED: 'engaged',
  MARRIED: 'married',
  NOT_INTERESTED: 'not_interested',
  TAKING_BREAK: 'taking_break',
  LEFT_SYSTEM: 'left_system',
  SHADCHAN_DECISION: 'shadchan_decision',
  OTHER: 'other',
} as const;
export type ClosureReason = (typeof ClosureReason)[keyof typeof ClosureReason];

// ── Match Suggestion Status ───────────────────────────────
export const MatchSuggestionStatus = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  SENT_SIDE_A: 'sent_side_a',
  SENT_SIDE_B: 'sent_side_b',
  SENT_BOTH: 'sent_both',
  ACCEPTED_SIDE_A: 'accepted_side_a',
  ACCEPTED_SIDE_B: 'accepted_side_b',
  ACCEPTED_BOTH: 'accepted_both',
  DATING: 'dating',
  DECLINED_SIDE_A: 'declined_side_a',
  DECLINED_SIDE_B: 'declined_side_b',
  DEFERRED: 'deferred',
  EXPIRED: 'expired',
  CLOSED: 'closed',
} as const;
export type MatchSuggestionStatus = (typeof MatchSuggestionStatus)[keyof typeof MatchSuggestionStatus];

// ── Match Type ────────────────────────────────────────────
export const MatchType = {
  SAFE: 'safe',
  BALANCED: 'balanced',
  CREATIVE: 'creative',
  RISKY: 'risky',
} as const;
export type MatchType = (typeof MatchType)[keyof typeof MatchType];

// ── Risk Level ────────────────────────────────────────────
export const RiskLevel = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

// ── Source Mode ───────────────────────────────────────────
export const SourceMode = {
  STRICT: 'strict',
  DISCOVERY: 'discovery',
} as const;
export type SourceMode = (typeof SourceMode)[keyof typeof SourceMode];

// ── Recommended Action ────────────────────────────────────
export const RecommendedAction = {
  SEND_NOW: 'send_now',
  REVIEW_FIRST: 'review_first',
  WAIT: 'wait',
  SKIP: 'skip',
} as const;
export type RecommendedAction = (typeof RecommendedAction)[keyof typeof RecommendedAction];

// ── Send Strategy ─────────────────────────────────────────
export const SendStrategy = {
  SIDE_A_FIRST: 'side_a_first',
  SIDE_B_FIRST: 'side_b_first',
  BOTH_SIMULTANEOUSLY: 'both_simultaneously',
} as const;
export type SendStrategy = (typeof SendStrategy)[keyof typeof SendStrategy];

// ── Channel Role ──────────────────────────────────────────
export const ChannelRole = {
  PROFILES_SOURCE: 'profiles_source',
  MATCH_SENDING: 'match_sending',
} as const;
export type ChannelRole = (typeof ChannelRole)[keyof typeof ChannelRole];

// ── Channel Provider ──────────────────────────────────────
export const ChannelProvider = {
  WHATSAPP_CLOUD: 'whatsapp_cloud',
  WHATSAPP_BUSINESS: 'whatsapp_business',
} as const;
export type ChannelProvider = (typeof ChannelProvider)[keyof typeof ChannelProvider];

// ── Channel Status ────────────────────────────────────────
export const ChannelStatus = {
  ACTIVE: 'active',
  DISCONNECTED: 'disconnected',
  RATE_LIMITED: 'rate_limited',
  SUSPENDED: 'suspended',
  REPLACED: 'replaced',
} as const;
export type ChannelStatus = (typeof ChannelStatus)[keyof typeof ChannelStatus];

// ── Webhook Status ────────────────────────────────────────
export const WebhookStatus = {
  VERIFIED: 'verified',
  PENDING: 'pending',
  FAILED: 'failed',
} as const;
export type WebhookStatus = (typeof WebhookStatus)[keyof typeof WebhookStatus];

// ── Conversation Purpose ──────────────────────────────────
export const ConversationPurpose = {
  PROFILE_INTAKE: 'profile_intake',
  MATCH_PROPOSAL: 'match_proposal',
  FOLLOW_UP: 'follow_up',
  GENERAL: 'general',
} as const;
export type ConversationPurpose = (typeof ConversationPurpose)[keyof typeof ConversationPurpose];

// ── Message Direction ─────────────────────────────────────
export const MessageDirection = {
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
} as const;
export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection];

// ── Message Content Type ──────────────────────────────────
export const MessageContentType = {
  TEXT: 'text',
  IMAGE: 'image',
  DOCUMENT: 'document',
  AUDIO: 'audio',
  VIDEO: 'video',
  LOCATION: 'location',
  CONTACT: 'contact',
  STICKER: 'sticker',
  TEMPLATE: 'template',
  INTERACTIVE: 'interactive',
} as const;
export type MessageContentType = (typeof MessageContentType)[keyof typeof MessageContentType];

// ── Message Delivery Status ───────────────────────────────
export const MessageDeliveryStatus = {
  PENDING: 'pending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
} as const;
export type MessageDeliveryStatus = (typeof MessageDeliveryStatus)[keyof typeof MessageDeliveryStatus];

// ── Task Status ───────────────────────────────────────────
export const TaskStatus = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  DEFERRED: 'deferred',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

// ── Task Priority ─────────────────────────────────────────
export const TaskPriority = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  URGENT: 'urgent',
} as const;
export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

// ── Task Type ─────────────────────────────────────────────
export const TaskType = {
  FOLLOW_UP: 'follow_up',
  CALL_CANDIDATE: 'call_candidate',
  SEND_PROPOSAL: 'send_proposal',
  VERIFY_PROFILE: 'verify_profile',
  CHECK_DATING_STATUS: 'check_dating_status',
  REVIEW_MATCH: 'review_match',
  GENERAL: 'general',
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

// ── Note Visibility ───────────────────────────────────────
export const NoteVisibility = {
  INTERNAL: 'internal',
  SENSITIVE: 'sensitive',
  OPERATIONAL: 'operational',
  SHARED: 'shared',
} as const;
export type NoteVisibility = (typeof NoteVisibility)[keyof typeof NoteVisibility];

// ── Share Card Photo Mode ─────────────────────────────────
export const ShareCardPhotoMode = {
  FULL: 'full',
  BLURRED: 'blurred',
  SILHOUETTE: 'silhouette',
  NONE: 'none',
} as const;
export type ShareCardPhotoMode = (typeof ShareCardPhotoMode)[keyof typeof ShareCardPhotoMode];

// ── Age Confidence (external candidates) ──────────────────
export const AgeConfidence = {
  EXACT: 'exact',
  APPROXIMATE: 'approximate',
  ESTIMATED: 'estimated',
  UNKNOWN: 'unknown',
} as const;
export type AgeConfidence = (typeof AgeConfidence)[keyof typeof AgeConfidence];

// ── Note Entity Type ──────────────────────────────────────
export const NoteEntityType = {
  INTERNAL_CANDIDATE: 'internal_candidate',
  EXTERNAL_CANDIDATE: 'external_candidate',
  MATCH_SUGGESTION: 'match_suggestion',
  CONVERSATION: 'conversation',
  TASK: 'task',
} as const;
export type NoteEntityType = (typeof NoteEntityType)[keyof typeof NoteEntityType];

// ── Audit Action Type ─────────────────────────────────────
export const AuditActionType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  ARCHIVE: 'archive',
  RESTORE: 'restore',
  STATUS_CHANGE: 'status_change',
  MATCH_SENT: 'match_sent',
  MATCH_APPROVED: 'match_approved',
  MATCH_DECLINED: 'match_declined',
  MESSAGE_SENT: 'message_sent',
  AI_QUERY: 'ai_query',
  LOGIN: 'login',
  EXPORT: 'export',
} as const;
export type AuditActionType = (typeof AuditActionType)[keyof typeof AuditActionType];

// ── Audit Entity Type ─────────────────────────────────────
export const AuditEntityType = {
  INTERNAL_CANDIDATE: 'internal_candidate',
  EXTERNAL_CANDIDATE: 'external_candidate',
  MATCH_SUGGESTION: 'match_suggestion',
  CONVERSATION: 'conversation',
  MESSAGE: 'message',
  CHANNEL: 'channel',
  TASK: 'task',
  NOTE: 'note',
  USER: 'user',
} as const;
export type AuditEntityType = (typeof AuditEntityType)[keyof typeof AuditEntityType];

// ── Message Extraction Status ─────────────────────────────
// Tracks the state of profile extraction on an inbound message
// from a profiles_source channel.
//   pending             — queued, not yet processed
//   skipped_not_profile — regex passes confirmed this is not a profile card
//   skipped_template    — blank template form (all labels empty)
//   matched_existing    — regex/AI identified an existing ExternalCandidate
//   created_new         — new ExternalCandidate created from this message
//   needs_review        — AI extracted but low confidence — awaiting human approval
//   failed              — extraction errored; reconciler may retry
export const MessageExtractionStatus = {
  PENDING: 'pending',
  SKIPPED_NOT_PROFILE: 'skipped_not_profile',
  SKIPPED_TEMPLATE: 'skipped_template',
  MATCHED_EXISTING: 'matched_existing',
  CREATED_NEW: 'created_new',
  NEEDS_REVIEW: 'needs_review',
  FAILED: 'failed',
} as const;
export type MessageExtractionStatus = (typeof MessageExtractionStatus)[keyof typeof MessageExtractionStatus];

// Which pipeline stage produced the extraction result.
export const ExtractionMethod = {
  REGEX: 'regex',
  AI: 'ai',
  MANUAL: 'manual',
} as const;
export type ExtractionMethod = (typeof ExtractionMethod)[keyof typeof ExtractionMethod];

// ── AI Request Type ───────────────────────────────────────
export const AIRequestType = {
  ASK: 'ask',
  EXPLAIN_MATCH: 'explain_match',
  SUMMARIZE: 'summarize',
  DRAFT: 'draft',
  CLASSIFY: 'classify',
  EMBED: 'embed',
} as const;
export type AIRequestType = (typeof AIRequestType)[keyof typeof AIRequestType];

// ── AI Provider ───────────────────────────────────────────
export const AIProvider = {
  GROQ: 'groq',
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  LOCAL: 'local',
} as const;
export type AIProvider = (typeof AIProvider)[keyof typeof AIProvider];

// ── Scoring Dimension Keys ────────────────────────────────
// The 8 approved dimensions for deterministic matching
export const ScoringDimension = {
  AGE: 'age',
  SECTOR: 'sector',
  LIFESTYLE: 'lifestyle',
  STUDY_WORK: 'study_work',
  LOCATION: 'location',
  MUTUAL_EXPECTATIONS: 'mutual_expectations',
  LIFE_STAGE: 'life_stage',
  FLEXIBILITY: 'flexibility',
} as const;
export type ScoringDimension = (typeof ScoringDimension)[keyof typeof ScoringDimension];
