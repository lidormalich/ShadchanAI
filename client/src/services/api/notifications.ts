import { api } from './client';

export interface NotificationItem {
  id: string;
  type: 'conversation.updated' | 'extraction.needs_review' | 'match.updated';
  at: string;
  title: string;
  payload: Record<string, unknown>;
}

export const notificationsApi = {
  list: (limit = 30) => api.get<NotificationItem[]>('/notifications', { limit }),
};
