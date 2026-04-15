import { api } from './client';
import type { BaileysChannelStatus, Channel } from '@/types/domain';

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
};
