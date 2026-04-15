import { api } from './client';
import type { Note } from '@/types/domain';

export const notesApi = {
  list: (query: { entityType: string; entityId: string; visibility?: string } & Record<string, unknown>) =>
    api.get<Note[]>('/notes', query),
  create: (body: {
    entityType: string;
    entityId: string;
    body: string;
    visibility?: string;
    mentions?: string[];
    pinned?: boolean;
  }) => api.post<Note>('/notes', body),
  update: (id: string, body: Partial<{ body: string; visibility: string; pinned: boolean; mentions: string[] }>) =>
    api.patch<Note>(`/notes/${id}`, body),
  delete: (id: string) => api.del<void>(`/notes/${id}`),
};
