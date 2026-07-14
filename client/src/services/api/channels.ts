import { api } from './client';
import type { BaileysChannelStatus, Channel } from '@/types/domain';

export interface DiscoveredChat {
  chatJid: string;
  chatType: 'group' | 'private';
  name: string;
  participantCount?: number;
  role?: 'profiles_source' | 'match_sending' | 'ignore';
  lastMessageAt?: string;
  hasConversation: boolean;
  conversationId?: string;
  // Messages stored but held back by the ingestion gate (waiting for a
  // mapping decision) — drives the "Pending" surface and backfill count.
  pendingMessageCount?: number;
  lastPendingAt?: string;
}

export interface ChatMessagePreview {
  id: string;
  senderName?: string;
  senderPhone?: string;
  direction: string;
  contentType: string;
  body?: string;
  mediaCaption?: string;
  mediaMimeType?: string;
  createdAt: string;
}

export interface ChatDiscoveryResult {
  channelId: string;
  liveSessionAvailable: boolean;
  /** Live Baileys state of the in-process client (null = no live client). */
  liveState: string | null;
  groupsFetched: number;
  /** Why the live group fetch returned nothing, when it did. */
  groupFetchError?: string;
  chats: DiscoveredChat[];
}

// ── Downtime coverage reports (post-reconnect verification) ──

export interface CoverageChatEntry {
  chatJid: string;
  chatName?: string;
  windowCount: number;
  baselineCount: number;
  baselinePerDay: number;
  expectedInWindow: number;
  suspect: boolean;
}

export interface CoverageReportView {
  id: string;
  channelId: string;
  accountDisplayName?: string;
  offlineFrom: string;
  offlineTo: string;
  offlineMs: number;
  messagesInWindow: number;
  chats: CoverageChatEntry[];
  suspectCount: number;
  createdAt: string;
}

// ── Multi-account admin: sessions overview + lock administration ──

export interface AdminSessionView {
  channelId: string;
  accountDisplayName: string;
  role: string;
  status: string;
  connectionHealth: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastConnectedAt?: string;
  lastDisconnectAt?: string;
  hasLiveClient: boolean;
  liveState: string | null;
  lastError?: string;
  lock: {
    ownerInstanceId: string | null;
    ownerHeartbeatAt: string | null;
    ageMs: number | null;
    isStale: boolean;
    isOurs: boolean;
  };
}

export interface AdminSessionsResponse {
  instanceId: string;
  sessions: AdminSessionView[];
}

export interface ForceReleaseLockResponse {
  released: boolean;
  previousOwner: string | null;
  previousHeartbeatAt: string | null;
  ageMs: number | null;
  lock: AdminSessionView['lock'];
}

export const channelsApi = {
  list: (query: Record<string, unknown> = {}) =>
    api.get<Channel[]>('/channels', query),
  get: (channelId: string) => api.get<Channel>(`/channels/${channelId}`),
  chain: (channelId: string) => api.get<Channel[]>(`/channels/${channelId}/chain`),
  health: () => api.get<Array<{
    channelId: string; role: string; status: string;
    connectionHealth: string; webhookStatus: string;
    lastInboundAt?: string; lastOutboundAt?: string;
  }>>('/channels/health'),
  connect: (body: {
    channelRole: string;
    accountDisplayName: string;
    phoneNumber: string;
    phoneNumberId?: string;
    tokenRef?: string;
  }) => api.post<Channel>('/channels', body),
  reconnect: (channelId: string) => api.post<Channel>(`/channels/${channelId}/reconnect`),
  disconnect: (channelId: string, body: { reason?: string } = {}) =>
    api.post<Channel>(`/channels/${channelId}/disconnect`, body),
  replace: (channelId: string, body: { newChannel: Record<string, unknown> }) =>
    api.post<{ oldChannel: Channel; newChannel: Channel }>(
      `/channels/${channelId}/replace`,
      body,
    ),
  sessionStart: (channelId: string) =>
    api.post<BaileysChannelStatus>(`/channels/${channelId}/session/start`),
  sessionStatus: (channelId: string) =>
    api.get<BaileysChannelStatus>(`/channels/${channelId}/session/status`),
  sessionStop: (channelId: string) =>
    api.post<BaileysChannelStatus>(`/channels/${channelId}/session/stop`),
  sessionLogout: (channelId: string) =>
    api.post<BaileysChannelStatus>(`/channels/${channelId}/session/logout`),
  // ── Pre-pilot discovery + mapping + safe delete ────────
  listChats: (channelId: string) =>
    api.get<ChatDiscoveryResult>(`/channels/${channelId}/chats`),
  assignChatRole: (channelId: string, body: {
    chatJid: string;
    chatType: 'group' | 'private';
    role: 'profiles_source' | 'match_sending' | 'ignore' | null;
    chatName?: string;
    backfillExisting?: boolean;
  }) => api.patch<{ channelId: string; chatJid: string; role: string | null; backfilled?: number }>(
    `/channels/${channelId}/chats/role`, body,
  ),
  // ── Pending channels (held-back chats) ──────────────────
  listPending: (channelId: string) =>
    api.get<ChatDiscoveryResult>(`/channels/${channelId}/pending`),
  backfillChat: (channelId: string, chatJid: string) =>
    api.post<{ channelId: string; chatJid: string; enqueued: number }>(
      `/channels/${channelId}/chats/backfill`, { chatJid },
    ),
  chatMessages: (channelId: string, chatJid: string, limit = 50) =>
    api.get<{ channelId: string; chatJid: string; messages: ChatMessagePreview[] }>(
      `/channels/${channelId}/chats/messages`, { chatJid, limit },
    ),
  historySync: (channelId: string, chatJid: string) =>
    api.post<{ requested: boolean; reason?: string }>(
      `/channels/${channelId}/chats/history-sync`, { chatJid },
    ),
  deleteChannel: (channelId: string) =>
    api.post<void>(`/channels/${channelId}/delete`, { confirmChannelId: channelId }),
  // ── Downtime coverage reports ───────────────────────────
  coverageReports: (days = 7, limit = 10) =>
    api.get<CoverageReportView[]>('/channels/coverage/reports', { days, limit }),
  // ── Multi-account admin ─────────────────────────────────
  adminSessions: () =>
    api.get<AdminSessionsResponse>('/channels/sessions/admin'),
  forceReleaseLock: (channelId: string, body: { reason: string }) =>
    api.post<ForceReleaseLockResponse>(`/channels/${channelId}/lock/release`, body),
};
