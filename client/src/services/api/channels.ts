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
}

export interface ChatDiscoveryResult {
  channelId: string;
  liveSessionAvailable: boolean;
  groupsFetched: number;
  chats: DiscoveredChat[];
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
  }) => api.patch<{ channelId: string; chatJid: string; role: string | null }>(
    `/channels/${channelId}/chats/role`, body,
  ),
  deleteChannel: (channelId: string) =>
    api.post<void>(`/channels/${channelId}/delete`, { confirmChannelId: channelId }),
  // ── Multi-account admin ─────────────────────────────────
  adminSessions: () =>
    api.get<AdminSessionsResponse>('/channels/sessions/admin'),
  forceReleaseLock: (channelId: string, body: { reason: string }) =>
    api.post<ForceReleaseLockResponse>(`/channels/${channelId}/lock/release`, body),
};
