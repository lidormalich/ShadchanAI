// ═══════════════════════════════════════════════════════════
// Dashboard queue row types (Phase 4).
//
// Each row is a discriminated union member — callers should
// switch on `type` and rely on the statically-typed remainder.
// All rows share the shape defined in DashboardRowBase so the UI
// can render category icon, owner chip, age and primary action
// without prior knowledge of the variant.
// ═══════════════════════════════════════════════════════════

export type DashboardRowType =
  | 'needs_review'
  | 'awaiting_response'
  | 'new_response'
  | 'inbound_action'
  | 'overdue_task'
  | 'high_potential_draft'
  | 'deferred_recheck';

export interface DashboardRowBase {
  type: DashboardRowType;
  id: string;               // canonical id for this row (entity id)
  title: string;            // main human-readable line
  context?: string;         // secondary line (optional)
  at: string;               // ISO timestamp the row is sorted / aged against
  ownerUserId?: string;     // resolves to a name via /api/users
  urgencyTier: number;      // 1 = most urgent, 9 = least (used for sort)
  primaryAction: string;    // verb shown on the primary button
  route: string;            // where the client should navigate on click
}

export interface NeedsReviewRow extends DashboardRowBase {
  type: 'needs_review';
  messageId: string;
  conversationId: string;
  channelId: string;
  confidence?: number;
}

export interface AwaitingResponseRow extends DashboardRowBase {
  type: 'awaiting_response';
  matchId: string;
  matchScore: number;
  matchType: string;
  side: 'a' | 'b' | 'both';
  internalCandidateId: string;
  externalCandidateId: string;
  hoursSinceSent: number;
}

export interface NewResponseRow extends DashboardRowBase {
  type: 'new_response';
  matchId: string;
  side: 'a' | 'b';
  responseStatus: string;
  conversationId?: string;
}

export interface InboundActionRow extends DashboardRowBase {
  type: 'inbound_action';
  conversationId: string;
  channelRole: string;
  unreadCount: number;
  matchSuggestionId?: string;
}

export interface OverdueTaskRow extends DashboardRowBase {
  type: 'overdue_task';
  taskId: string;
  dueAt: string;
  priority: string;
  relatedEntity?: {
    internalCandidateId?: string;
    externalCandidateId?: string;
    matchSuggestionId?: string;
    conversationId?: string;
  };
}

export interface HighPotentialDraftRow extends DashboardRowBase {
  type: 'high_potential_draft';
  matchId: string;
  matchScore: number;
  matchType: string;
  internalCandidateId: string;
  externalCandidateId: string;
}

export interface DeferredRecheckRow extends DashboardRowBase {
  type: 'deferred_recheck';
  matchId: string;
  deferredAt: string;
  deferredReason?: string;
}

export type DashboardRow =
  | NeedsReviewRow
  | AwaitingResponseRow
  | NewResponseRow
  | InboundActionRow
  | OverdueTaskRow
  | HighPotentialDraftRow
  | DeferredRecheckRow;

// Tunable thresholds. Kept here so the product rule is in one
// readable place instead of scattered through the service.
export const DASHBOARD_THRESHOLDS = {
  AWAITING_RESPONSE_HOURS: 48,    // match SENT but nothing back yet
  HIGH_POTENTIAL_MIN_SCORE: 75,   // unsent match that probably should go out
  HIGH_POTENTIAL_MIN_AGE_HOURS: 24,
  DEFERRED_MIN_AGE_HOURS: 24,     // don't surface deferred recheck same-day
} as const;
