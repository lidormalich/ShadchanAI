import { api } from './client';

export interface SearchResult {
  type: 'internal_candidate' | 'external_candidate' | 'pending_review' | 'match' | 'conversation' | 'task';
  id: string;
  title: string;
  subtitle?: string;
  route: string;
}

export const searchApi = {
  query: (q: string, limit = 12) => api.get<SearchResult[]>('/search', { q, limit }),
};
