import { api } from './client';

export interface GenderBreakdown {
  male: number;
  female: number;
  unknown: number;
}

export interface InsightsSummary {
  funnel: Array<{ key: string; label: string; count: number }>;
  counters: {
    activeInternals: number;
    datingInternals: number;
    activeExternals: number;
    sentThisWeek: number;
    responsesThisWeek: number;
    acceptedThisWeek: number;
    newCandidatesThisWeek: number;
    openTasks: number;
    needsReview: number;
  };
  gender: {
    internal: GenderBreakdown;
    external: GenderBreakdown;
  };
}

export interface GenderSuspect {
  id: string;
  name: string;
  storedGender: 'male' | 'female';
  inferredGender: 'male' | 'female';
  maleWeight: number;
  femaleWeight: number;
  snippet: string;
}

export interface GenderQuality {
  suspects: GenderSuspect[];
  scanned: number;
  capped: boolean;
}

export const insightsApi = {
  summary: () => api.get<InsightsSummary>('/insights/summary'),
  genderQuality: () => api.get<GenderQuality>('/insights/gender-quality'),
};
