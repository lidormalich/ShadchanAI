import { api } from './client';

export type DashboardRowType =
  | 'needs_review'
  | 'awaiting_response'
  | 'new_response'
  | 'inbound_action'
  | 'overdue_task'
  | 'high_potential_draft'
  | 'deferred_recheck';

interface Base {
  type: DashboardRowType;
  id: string;
  title: string;
  context?: string;
  at: string;
  ownerUserId?: string;
  urgencyTier: number;
  primaryAction: string;
  route: string;
}

export interface NeedsReviewRow extends Base {
  type: 'needs_review';
  messageId: string;
  conversationId: string;
  channelId: string;
  confidence?: number;
}

export interface AwaitingResponseRow extends Base {
  type: 'awaiting_response';
  matchId: string;
  matchScore: number;
  matchType: string;
  side: 'a' | 'b' | 'both';
  internalCandidateId: string;
  externalCandidateId: string;
  hoursSinceSent: number;
}

export interface NewResponseRow extends Base {
  type: 'new_response';
  matchId: string;
  side: 'a' | 'b';
  responseStatus: string;
  conversationId?: string;
}

export interface InboundActionRow extends Base {
  type: 'inbound_action';
  conversationId: string;
  channelRole: string;
  unreadCount: number;
  matchSuggestionId?: string;
}

export interface OverdueTaskRow extends Base {
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

export interface HighPotentialDraftRow extends Base {
  type: 'high_potential_draft';
  matchId: string;
  matchScore: number;
  matchType: string;
  internalCandidateId: string;
  externalCandidateId: string;
}

export interface DeferredRecheckRow extends Base {
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

export const dashboardApi = {
  queue: (query: { ownership?: 'mine' | 'team' | 'all'; limit?: number; type?: DashboardRowType } = {}) =>
    api.get<DashboardRow[]>('/dashboard/queue', query),
};
