import { api } from './client';
import type { Conversation, Message } from '@/types/domain';

export const conversationsApi = {
  list: (query: Record<string, unknown> = {}) =>
    api.get<Conversation[]>('/conversations', query),
  byRole: (role: 'profiles_source' | 'match_sending', query: Record<string, unknown> = {}) =>
    api.get<Conversation[]>(`/conversations/role/${role}`, query),
  get: (id: string) => api.get<Conversation>(`/conversations/${id}`),
  chain: (id: string) => api.get<Conversation[]>(`/conversations/${id}/chain`),
  messages: (id: string, query: Record<string, unknown> = {}) =>
    api.get<Message[]>(`/conversations/${id}/messages`, query),
  markRead: (id: string) => api.post<Conversation>(`/conversations/${id}/mark-read`),
  link: (id: string, body: { internalCandidateId?: string; externalCandidateId?: string; matchSuggestionId?: string }) =>
    api.patch<Conversation>(`/conversations/${id}/link`, body),
  sendMessage: (id: string, body: { body: string }) =>
    api.post<{ messageId: string; externalMessageId: string }>(`/conversations/${id}/send-message`, body),
};
