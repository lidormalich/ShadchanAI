import { api } from './client';

export interface InsightsSummary {
  funnel: Array<{ key: string; label: string; count: number }>;
  counters: {
    activeInternals: number;
    datingInternals: number;
    activeExternals: number;
    sentThisWeek: number;
    openTasks: number;
    needsReview: number;
  };
}

export const insightsApi = {
  summary: () => api.get<InsightsSummary>('/insights/summary'),
};
