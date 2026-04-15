import { api } from './client';
import type { AskAIResult } from '@/types/domain';

export const aiApi = {
  explainMatch: (body: Record<string, unknown>) =>
    api.post<Record<string, unknown>>('/ai/explain-match', body),
  summarizeCandidate: (body: Record<string, unknown>) =>
    api.post<Record<string, unknown>>('/ai/summarize-candidate', body),
  classifyMessage: (body: { text: string; context?: Record<string, unknown> }) =>
    api.post<Record<string, unknown>>('/ai/classify-message', body),
  suggestNextStep: (body: Record<string, unknown>) =>
    api.post<Record<string, unknown>>('/ai/suggest-next-step', body),
  generateMessage: (body: Record<string, unknown>) =>
    api.post<Record<string, unknown>>('/ai/generate-message', body),
  ask: (body: { query: string; forceIntent?: string }) =>
    api.post<AskAIResult>('/ai/ask', body),
};
