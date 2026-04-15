import { api } from './client';
import type { Task } from '@/types/domain';

export const tasksApi = {
  list: (query: Record<string, unknown> = {}) => api.get<Task[]>('/tasks', query),
  get: (id: string) => api.get<Task>(`/tasks/${id}`),
  create: (body: Partial<Task>) => api.post<Task>('/tasks', body),
  update: (id: string, body: Partial<Task>) => api.patch<Task>(`/tasks/${id}`, body),
  complete: (id: string, body: { completionNote?: string } = {}) =>
    api.post<Task>(`/tasks/${id}/complete`, body),
  reassign: (id: string, body: { assignedTo: string }) =>
    api.post<Task>(`/tasks/${id}/reassign`, body),
};
