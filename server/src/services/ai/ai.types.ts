// ═══════════════════════════════════════════════════════════
// ShadchanAI — AI Service Types
//
// All input/output shapes, provider interface, and metadata
// for the AI service layer. AI is read-only: it never mutates
// business entities. All outputs are validated before use.
// ═══════════════════════════════════════════════════════════

import type { AIRequestType, AIProvider } from '@shadchanai/shared';

// ── Chat message (OpenAI-compatible) ─────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ── Provider interface ───────────────────────────────────

export interface ProviderChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /** Strict retry mode: re-ask the model to produce valid JSON */
  strictRetry?: boolean;
}

export interface ProviderChatResponse {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  model: string;
}

export interface AIProviderClient {
  readonly name: AIProvider;
  readonly model: string;
  isAvailable(): boolean;
  chat(messages: ChatMessage[], options?: ProviderChatOptions): Promise<ProviderChatResponse>;
}

// ── Embedding provider ───────────────────────────────────

export interface EmbeddingResponse {
  vector: number[];
  model: string;
  dimensions: number;
}

export interface EmbeddingProviderClient {
  readonly name: string;
  readonly model: string;
  isAvailable(): boolean;
  embed(text: string): Promise<EmbeddingResponse>;
}

// ── Response metadata (attached to every AI result) ──────

export interface AIResponseMetadata {
  provider: AIProvider;
  model: string;
  modelVersion?: string;
  fallbackUsed: boolean;
  retryCount: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cached: boolean;
  generatedAt: Date;
}

export interface AIResponse<T> {
  data: T;
  metadata: AIResponseMetadata;
}

// ── Method inputs ────────────────────────────────────────

/** Compact candidate info passed to prompts — never full DB docs */
export interface CandidateBrief {
  id: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  subSector?: string;
  lifestyleTone?: string;
  personalStatus?: string;
  lifeStage?: string;
  studyWorkDirection?: string;
  about?: string;
  whatSeeking?: string;
}

export interface ExplainMatchInput {
  internal: CandidateBrief;
  external: CandidateBrief;
  matchScore: number;
  confidenceScore: number;
  matchType: string;
  riskLevel: string;
  strengths: string[];
  attentionPoints: string[];
  scoreBreakdown: Array<{ dimension: string; score: number; detail: string }>;
}

export interface ExplainMatchOutput {
  summary: string;
  strengths: string[];
  concerns: string[];
  nuance: string;
  recommendedApproach: string;
}

export interface GenerateMessageInput {
  purpose: 'intro' | 'follow_up' | 'decline' | 'scheduling' | 'general';
  recipient: CandidateBrief;
  aboutCandidate?: CandidateBrief;
  tone: 'warm' | 'formal' | 'concise' | 'respectful';
  language: 'he' | 'en';
  additionalContext?: string;
  /** Shadchan can pass constraints like "do not mention family status" */
  constraints?: string[];
}

export interface GenerateMessageOutput {
  message: string;
  tone: string;
  language: string;
  reviewFlags: string[];
}

export interface SummarizeCandidateInput {
  candidate: CandidateBrief & {
    profileCompletion?: number;
    missingCriticalFields?: string[];
    references?: string;
  };
}

export interface SummarizeCandidateOutput {
  summary: string;
  personalityTraits: string[];
  values: string[];
  communicationStyle: string;
  warnings: string[];
}

export interface ClassifyMessageInput {
  text: string;
  context?: {
    purpose?: string;
    previousMessages?: string[];
  };
}

export interface ClassifyMessageOutput {
  intent: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed' | 'unknown';
  language: string;
  urgency: 'low' | 'normal' | 'high';
  actionNeeded: boolean;
  confidence: number;
}

export interface SuggestNextStepInput {
  matchStatus: string;
  matchType: string;
  recommendedAction: string;
  daysSinceLastAction?: number;
  sideAResponse?: string;
  sideBResponse?: string;
  ownerNote?: string;
}

export interface SuggestNextStepOutput {
  action: string;
  reason: string;
  urgency: 'low' | 'normal' | 'high';
  alternatives: string[];
}

// ── Ask AI ───────────────────────────────────────────────

export type AskAIIntent =
  | 'find_matching_candidates'
  | 'find_unhandled_candidates'
  | 'find_high_potential_matches'
  | 'find_stale_candidates'
  | 'find_similar_candidates'
  | 'find_active_issues'
  | 'summarize_candidate'
  | 'unknown';

export interface AskAIInput {
  query: string;
  /** User scope — which Shadchan is asking */
  userId?: string;
  /** Optional explicit intent override */
  forceIntent?: AskAIIntent;
}

export interface AskAIFilters {
  candidateId?: string;
  sectorGroup?: string;
  subSector?: string;
  city?: string;
  ageMin?: number;
  ageMax?: number;
  mode?: 'strict' | 'discovery';
  matchType?: string;
  limit?: number;
  daysSinceAction?: number;
  [key: string]: unknown;
}

export interface AskAIOutput {
  intent: AskAIIntent;
  appliedFilters: AskAIFilters;
  results: unknown[];
  reasoningSummary: string;
  recommendedActions: string[];
  warnings: string[];
}

// ── Cache entry ──────────────────────────────────────────

export interface CacheEntry<T = unknown> {
  data: T;
  metadata: AIResponseMetadata;
  expiresAt: number;
}

// ── Logger record ────────────────────────────────────────

export interface AILogRecord {
  requestType: AIRequestType;
  provider: AIProvider;
  model: string;
  inputHash: string;
  success: boolean;
  fallbackUsed: boolean;
  fallbackProvider?: string;
  retryCount: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  errorMessage?: string;
  errorCode?: string;
  userId?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}
