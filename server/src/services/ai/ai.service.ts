// ═══════════════════════════════════════════════════════════
// ShadchanAI — AI Service (Public Facade)
//
// Orchestrates every AI flow:
//
//   1. Build prompt (pure function)
//   2. Check cache (if applicable)
//   3. Try primary provider (Groq)
//   4. Validate structured output
//   5. If invalid, retry once with strictRetry prompt
//   6. If still invalid, fall back to secondary provider
//   7. Validate fallback output; fail if still invalid
//   8. Log metadata (provider/model/fallback/retry/latency)
//   9. Cache result (if applicable)
//  10. Return { data, metadata }
//
// The service never accesses the DB directly — it uses the
// tools layer (ai.tools.ts) for any data needs.
// The service never mutates business entities.
// ═══════════════════════════════════════════════════════════

import { z } from 'zod';
import { AIRequestType, AIProvider } from '@shadchanai/shared';

import type {
  AIProviderClient,
  AIResponse,
  AIResponseMetadata,
  ChatMessage,
  ExplainMatchInput,
  ExplainMatchOutput,
  GenerateMessageInput,
  GenerateMessageOutput,
  SummarizeCandidateInput,
  SummarizeCandidateOutput,
  ClassifyMessageInput,
  ClassifyMessageOutput,
  SuggestNextStepInput,
  SuggestNextStepOutput,
  AskAIInput,
  AskAIOutput,
  AskAIIntent,
  EmbeddingResponse,
  ProviderChatOptions,
} from './ai.types.js';

import {
  buildExplainMatchPrompt,
  buildGenerateMessagePrompt,
  buildSummarizeCandidatePrompt,
  buildClassifyMessagePrompt,
  buildSuggestNextStepPrompt,
  buildAskAIIntentPrompt,
  buildAskAISummaryPrompt,
} from './ai.prompts.js';

import {
  ExplainMatchOutputSchema,
  GenerateMessageOutputSchema,
  SummarizeCandidateOutputSchema,
  ClassifyMessageOutputSchema,
  SuggestNextStepOutputSchema,
  AskAIIntentDetectionSchema,
  parseAndValidate,
} from './ai.validators.js';

import { Types } from 'mongoose';
import { CandidateInsight } from '../../models/index.js';
import { cacheGet, cacheSet, hashKey } from './ai.cache.js';
import { logAIRequest } from './ai.logger.js';
import { groqProvider } from './providers/groq.provider.js';
import { openaiProvider } from './providers/openai.provider.js';
import { embeddingsProvider } from './providers/embeddings.provider.js';

import * as tools from './ai.tools.js';
import { env } from '../../config/env.js';
import { BusinessRuleError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';
import { getSettingStringCached, getSettingCached } from '../../modules/settings/settings.service.js';

const log = createLogger('ai');

// Resolve which engine is primary. The `ai.engine` setting (operator-set in
// the UI) overrides the AI_ENGINE env default; the other engine auto-serves
// as the fallback. On any settings read error we fall back to the env value.
async function resolveEngines(): Promise<{ primary: AIProviderClient; secondary: AIProviderClient }> {
  let engine: string = env.AI_ENGINE;
  try {
    engine = await getSettingStringCached('ai.engine');
  } catch {
    // keep the env default
  }
  return engine === 'openai'
    ? { primary: openaiProvider, secondary: groqProvider }
    : { primary: groqProvider, secondary: openaiProvider };
}

// ══════════════════════════════════════════════════════════
// Core orchestrator (private)
// ══════════════════════════════════════════════════════════

interface ExecuteOptions<T> {
  requestType: AIRequestType;
  buildPrompt: (strictRetry: boolean) => ChatMessage[];
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Stable cache key; omit to skip caching */
  cacheKey?: string;
  /** Per-call provider options (e.g. a larger maxTokens for long extractions) */
  chatOptions?: ProviderChatOptions;
  userId?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

// ── Daily budget guard ────────────────────────────────────
// Counts provider-hitting requests (cache hits don't consume budget).
// The limit is operator-tunable at runtime ('ai.daily_request_budget'
// setting); the env var is only the default.
let budgetDay = '';
let budgetUsed = 0;

async function resolveDailyBudgetLimit(): Promise<number> {
  try {
    return (await getSettingCached('ai.daily_request_budget')) as number;
  } catch {
    return env.AI_DAILY_REQUEST_BUDGET;
  }
}

async function consumeDailyBudget(requestType: string): Promise<void> {
  const limit = await resolveDailyBudgetLimit();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    budgetUsed = 0;
  }
  if (limit > 0 && budgetUsed >= limit) {
    throw new BusinessRuleError(
      `AI daily request budget exhausted (${limit}/day)`,
      { code: 'ai_budget_exhausted', requestType },
    );
  }
  budgetUsed += 1;
}

export async function aiBudgetSnapshot(): Promise<{ limit: number; usedToday: number; day: string }> {
  return { limit: await resolveDailyBudgetLimit(), usedToday: budgetUsed, day: budgetDay };
}

export async function executeWithFallback<T>(
  opts: ExecuteOptions<T>,
): Promise<AIResponse<T>> {
  const { requestType, buildPrompt, schema, cacheKey, chatOptions, userId, relatedEntityType, relatedEntityId } = opts;

  if (env.AI_DISABLED) {
    throw new BusinessRuleError('AI is disabled by configuration', { code: 'ai_disabled' });
  }

  // ── 1. Cache check ────────────────────────────────────
  if (cacheKey) {
    const cached = cacheGet<T>(cacheKey);
    if (cached) {
      return {
        data: cached.data,
        metadata: { ...cached.metadata, cached: true },
      };
    }
  }

  // ── 1b. Daily spend guard (provider-hitting requests only) ─
  await consumeDailyBudget(requestType);

  const { primary: primaryProvider, secondary: secondaryProvider } = await resolveEngines();

  const started = Date.now();
  let retryCount = 0;
  let fallbackUsed = false;
  let provider: AIProviderClient = primaryProvider;
  let lastError: string | undefined;
  let result: T | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let finalModel = provider.model;

  const inputHash = cacheKey ?? hashKey(requestType, buildPrompt(false));

  // ── 2. Try the primary engine (AI_ENGINE) ─────────────
  if (primaryProvider.isAvailable()) {
    try {
      const response = await primaryProvider.chat(buildPrompt(false), { jsonMode: true, ...chatOptions });
      const parsed = parseAndValidate(response.content, schema);
      if (parsed.ok && parsed.data !== undefined) {
        result = parsed.data;
        inputTokens = response.inputTokens;
        outputTokens = response.outputTokens;
        finalModel = response.model;
      } else {
        // ── 3. Retry once with strict prompt ───────────
        retryCount = 1;
        lastError = parsed.error;
        try {
          const retry = await primaryProvider.chat(buildPrompt(true), { jsonMode: true, ...chatOptions });
          const reparsed = parseAndValidate(retry.content, schema);
          if (reparsed.ok && reparsed.data !== undefined) {
            result = reparsed.data;
            inputTokens = retry.inputTokens;
            outputTokens = retry.outputTokens;
            finalModel = retry.model;
            lastError = undefined;
          } else {
            lastError = reparsed.error;
          }
        } catch (e) {
          lastError = `${primaryProvider.name} retry failed: ${(e as Error).message}`;
        }
      }
    } catch (e) {
      lastError = `${primaryProvider.name} request failed: ${(e as Error).message}`;
    }
  } else {
    lastError = `${primaryProvider.name} provider not configured`;
  }

  // ── 4. Fallback to the other engine if the primary failed ─
  if (result === undefined && secondaryProvider.isAvailable()) {
    log.warn(
      { primary: primaryProvider.name, fallback: secondaryProvider.name, reason: lastError },
      'primary AI failed — falling back',
    );
    fallbackUsed = true;
    provider = secondaryProvider;
    // Attribute the attempt to the model actually being called — without
    // this, a failed fallback logs provider=secondary with the PRIMARY's
    // model id (e.g. "openai/llama-3.3-70b"), which garbles the cost report.
    finalModel = secondaryProvider.model;
    try {
      const response = await secondaryProvider.chat(buildPrompt(false), { jsonMode: true, ...chatOptions });
      const parsed = parseAndValidate(response.content, schema);
      if (parsed.ok && parsed.data !== undefined) {
        result = parsed.data;
        inputTokens = response.inputTokens;
        outputTokens = response.outputTokens;
        finalModel = response.model;
        lastError = undefined;
      } else {
        lastError = `Fallback validation failed: ${parsed.error}`;
      }
    } catch (e) {
      lastError = `Fallback request failed: ${(e as Error).message}`;
    }
  } else if (result === undefined) {
    // Primary failed and there's no usable fallback — surface this loudly,
    // otherwise a Groq rate-limit (429) silently sinks every extraction with
    // no second chance. This is the "processed but nothing created" symptom.
    log.warn(
      { primary: primaryProvider.name, secondaryConfigured: secondaryProvider.isAvailable(), reason: lastError },
      'AI primary failed and no fallback available',
    );
  }

  const latencyMs = Date.now() - started;

  // ── 5. Log (best-effort, never throws) ────────────────
  await logAIRequest({
    requestType,
    provider: provider.name,
    model: finalModel,
    inputHash,
    success: result !== undefined,
    fallbackUsed,
    fallbackProvider: fallbackUsed ? secondaryProvider.name : undefined,
    retryCount,
    latencyMs,
    inputTokens,
    outputTokens,
    errorMessage: lastError,
    userId,
    relatedEntityType,
    relatedEntityId,
  });

  // ── 6. Throw if no valid result ───────────────────────
  if (result === undefined) {
    throw new AIServiceError(
      `AI request '${requestType}' failed across all providers: ${lastError ?? 'unknown error'}`,
      { provider: provider.name, fallbackUsed, retryCount, latencyMs },
    );
  }

  const metadata: AIResponseMetadata = {
    provider: provider.name,
    model: finalModel,
    fallbackUsed,
    retryCount,
    latencyMs,
    inputTokens,
    outputTokens,
    cached: false,
    generatedAt: new Date(),
  };

  // ── 7. Cache ──────────────────────────────────────────
  if (cacheKey) {
    cacheSet(cacheKey, result, metadata);
  }

  return { data: result, metadata };
}

export class AIServiceError extends Error {
  constructor(
    message: string,
    public readonly info: {
      provider: AIProvider;
      fallbackUsed: boolean;
      retryCount: number;
      latencyMs: number;
    },
  ) {
    super(message);
    this.name = 'AIServiceError';
  }
}

// ══════════════════════════════════════════════════════════
// Public AI methods
// ══════════════════════════════════════════════════════════

export async function explainMatch(
  input: ExplainMatchInput,
  options: { userId?: string; suggestionId?: string } = {},
): Promise<AIResponse<ExplainMatchOutput>> {
  // Fold in the candidate's LEARNED preference profile (built by the
  // learning agent from status-change reasons) so the explanation is
  // grounded in what this candidate actually accepted/declined before.
  if (!input.learnedInsight) {
    try {
      // Model import (not candidate-learning.service) — that service
      // imports executeWithFallback from THIS module; going through it
      // here would create an import cycle.
      const insight = Types.ObjectId.isValid(input.internal.id)
        ? await CandidateInsight.findOne({ candidateId: new Types.ObjectId(input.internal.id) })
            .select('summary positiveSignals negativeSignals guidance')
            .lean()
            .exec()
        : null;
      if (insight) {
        input = {
          ...input,
          learnedInsight: {
            summary: insight.summary,
            positiveSignals: insight.positiveSignals,
            negativeSignals: insight.negativeSignals,
            guidance: insight.guidance,
          },
        };
      }
    } catch { /* advisory — never block the explanation */ }
  }

  const cacheKey = hashKey('explainMatch', {
    internalId: input.internal.id,
    externalId: input.external.id,
    matchScore: input.matchScore,
    confidenceScore: input.confidenceScore,
    matchType: input.matchType,
    // Insight changes must bust the cached explanation.
    insight: input.learnedInsight?.summary ?? null,
  });

  return executeWithFallback<ExplainMatchOutput>({
    requestType: AIRequestType.EXPLAIN_MATCH,
    buildPrompt: (strict) => buildExplainMatchPrompt(input, strict),
    schema: ExplainMatchOutputSchema,
    cacheKey,
    userId: options.userId,
    relatedEntityType: 'match_suggestion',
    relatedEntityId: options.suggestionId,
  });
}

export async function generateMessage(
  input: GenerateMessageInput,
  options: { userId?: string; conversationId?: string } = {},
): Promise<AIResponse<GenerateMessageOutput>> {
  // Messages are NOT cached — every draft is user-specific
  return executeWithFallback<GenerateMessageOutput>({
    requestType: AIRequestType.DRAFT,
    buildPrompt: (strict) => buildGenerateMessagePrompt(input, strict),
    schema: GenerateMessageOutputSchema,
    userId: options.userId,
    relatedEntityType: 'conversation',
    relatedEntityId: options.conversationId,
  });
}

export async function summarizeCandidate(
  input: SummarizeCandidateInput,
  options: { userId?: string } = {},
): Promise<AIResponse<SummarizeCandidateOutput>> {
  const cacheKey = hashKey('summarizeCandidate', {
    candidateId: input.candidate.id,
    // incorporate any updatedAt signal the caller passed (via candidate object)
  });

  return executeWithFallback<SummarizeCandidateOutput>({
    requestType: AIRequestType.SUMMARIZE,
    buildPrompt: (strict) => buildSummarizeCandidatePrompt(input, strict),
    schema: SummarizeCandidateOutputSchema,
    cacheKey,
    userId: options.userId,
    relatedEntityType: 'internal_candidate',
    relatedEntityId: input.candidate.id,
  });
}

export async function classifyMessage(
  input: ClassifyMessageInput,
  options: { userId?: string; messageId?: string } = {},
): Promise<AIResponse<ClassifyMessageOutput>> {
  const cacheKey = hashKey('classifyMessage', { text: input.text, context: input.context });

  return executeWithFallback<ClassifyMessageOutput>({
    requestType: AIRequestType.CLASSIFY,
    buildPrompt: (strict) => buildClassifyMessagePrompt(input, strict),
    schema: ClassifyMessageOutputSchema,
    cacheKey,
    userId: options.userId,
    relatedEntityType: 'message',
    relatedEntityId: options.messageId,
  });
}

export async function suggestNextStep(
  input: SuggestNextStepInput,
  options: { userId?: string; suggestionId?: string } = {},
): Promise<AIResponse<SuggestNextStepOutput>> {
  const cacheKey = hashKey('suggestNextStep', input);

  return executeWithFallback<SuggestNextStepOutput>({
    requestType: AIRequestType.ASK, // closest existing enum — suggestions are advisory
    buildPrompt: (strict) => buildSuggestNextStepPrompt(input, strict),
    schema: SuggestNextStepOutputSchema,
    cacheKey,
    userId: options.userId,
    relatedEntityType: 'match_suggestion',
    relatedEntityId: options.suggestionId,
  });
}

// ══════════════════════════════════════════════════════════
// Ask AI (controlled query layer)
// ══════════════════════════════════════════════════════════

export async function askAI(
  input: AskAIInput,
): Promise<AIResponse<AskAIOutput>> {
  const started = Date.now();

  // ── Step 1: Detect intent + extract filters ───────────
  let intent: AskAIIntent;
  let filters: Record<string, unknown>;
  let intentMetadata: AIResponseMetadata | null = null;

  if (input.forceIntent) {
    intent = input.forceIntent;
    filters = {};
  } else {
    const detection = await executeWithFallback({
      requestType: AIRequestType.CLASSIFY,
      buildPrompt: (strict) => buildAskAIIntentPrompt(input.query, strict),
      schema: AskAIIntentDetectionSchema,
      userId: input.userId,
    });
    intent = detection.data.intent;
    filters = { ...detection.data.filters };
    intentMetadata = detection.metadata;
  }

  // ── Step 2: Dispatch to tool ──────────────────────────
  const toolResult = await dispatchTool(intent, filters);
  const warnings = [...toolResult.warnings];

  // ── Step 3: Generate reasoning summary ────────────────
  let reasoningSummary = '';
  let recommendedActions: string[] = [];
  let summaryMetadata: AIResponseMetadata | null = null;

  if (toolResult.results.length > 0 || intent !== 'unknown') {
    try {
      const summary = await executeWithFallback({
        requestType: AIRequestType.ASK,
        buildPrompt: (strict) => buildAskAISummaryPrompt(
          intent, input.query, toolResult.results, toolResult.appliedFilters, strict,
        ),
        schema: z.object({
          reasoningSummary: z.string().trim().max(2000).default(''),
          recommendedActions: z.array(z.string().trim().min(1)).max(10).default([]),
          warnings: z.array(z.string().trim().min(1)).max(10).default([]),
        }),
        userId: input.userId,
      });
      reasoningSummary = summary.data.reasoningSummary;
      recommendedActions = summary.data.recommendedActions;
      warnings.push(...summary.data.warnings);
      summaryMetadata = summary.metadata;
    } catch (e) {
      // If summarization fails, we still return the deterministic tool results.
      warnings.push(`יצירת הסיכום נכשלה: ${(e as Error).message}`);
    }
  } else {
    reasoningSummary = 'לא נמצאו תוצאות. כדאי להרחיב את השאלה או לבדוק את מזהה הכרטיס.';
  }

  const output: AskAIOutput = {
    intent,
    appliedFilters: toolResult.appliedFilters,
    results: toolResult.results,
    reasoningSummary,
    recommendedActions,
    warnings,
  };

  const metadata: AIResponseMetadata = {
    provider: summaryMetadata?.provider ?? intentMetadata?.provider ?? AIProvider.GROQ,
    model: summaryMetadata?.model ?? intentMetadata?.model ?? 'n/a',
    fallbackUsed: (summaryMetadata?.fallbackUsed ?? false) || (intentMetadata?.fallbackUsed ?? false),
    retryCount: (summaryMetadata?.retryCount ?? 0) + (intentMetadata?.retryCount ?? 0),
    latencyMs: Date.now() - started,
    cached: false,
    generatedAt: new Date(),
  };

  return { data: output, metadata };
}

// ── Tool dispatch (deterministic — no LLM) ───────────────

interface ToolDispatchResult {
  results: unknown[];
  appliedFilters: Record<string, unknown>;
  warnings: string[];
}

async function dispatchTool(
  intent: AskAIIntent,
  filters: Record<string, unknown>,
): Promise<ToolDispatchResult> {
  const warnings: string[] = [];
  const applied = { ...filters };

  switch (intent) {
    case 'find_matching_candidates': {
      if (!filters['candidateId']) {
        warnings.push('חיפוש התאמות דורש מזהה כרטיס — לא זוהה מזהה בשאלה.');
        return { results: [], appliedFilters: applied, warnings };
      }
      const result = await tools.getMatchingCandidatesTool({
        internalCandidateId: String(filters['candidateId']),
        mode: (filters['mode'] as 'strict' | 'discovery') ?? 'strict',
        limit: typeof filters['limit'] === 'number' ? (filters['limit'] as number) : 20,
        externalFilter: {
          sectorGroup: filters['sectorGroup'] as string | undefined,
          subSector: filters['subSector'] as string | undefined,
          city: filters['city'] as string | undefined,
          ageMin: filters['ageMin'] as number | undefined,
          ageMax: filters['ageMax'] as number | undefined,
        },
      });
      if (!result.internalFound) {
        warnings.push(`כרטיס פנימי ${filters['candidateId']} לא נמצא.`);
      }
      return { results: result.results, appliedFilters: applied, warnings };
    }

    case 'find_unhandled_candidates': {
      const results = await tools.getUnhandledCandidatesTool({
        daysSinceAction: typeof filters['daysSinceAction'] === 'number'
          ? (filters['daysSinceAction'] as number) : 30,
        limit: typeof filters['limit'] === 'number' ? (filters['limit'] as number) : 25,
      });
      return { results, appliedFilters: applied, warnings };
    }

    case 'find_high_potential_matches': {
      const results = await tools.getHighScoreMatchesTool({
        minScore: 75,
        matchType: filters['matchType'] as string | undefined,
        limit: typeof filters['limit'] === 'number' ? (filters['limit'] as number) : 25,
      });
      return { results, appliedFilters: applied, warnings };
    }

    case 'find_stale_candidates': {
      const results = await tools.getStaleCandidatesTool({
        daysSinceUpdate: typeof filters['daysSinceAction'] === 'number'
          ? (filters['daysSinceAction'] as number) : 60,
        limit: typeof filters['limit'] === 'number' ? (filters['limit'] as number) : 25,
      });
      return { results, appliedFilters: applied, warnings };
    }

    case 'find_similar_candidates': {
      if (!filters['candidateId']) {
        warnings.push('חיפוש כרטיסים דומים דורש מזהה כרטיס — לא זוהה מזהה בשאלה.');
        return { results: [], appliedFilters: applied, warnings };
      }
      const results = await tools.getSimilarCandidatesTool({
        candidateId: String(filters['candidateId']),
        scope: 'external',
        limit: typeof filters['limit'] === 'number' ? (filters['limit'] as number) : 10,
      });
      return { results, appliedFilters: applied, warnings };
    }

    case 'find_active_issues': {
      const results = await tools.getCandidatesNeedingAttentionTool({
        limit: typeof filters['limit'] === 'number' ? (filters['limit'] as number) : 25,
        reasonFilter: 'any',
      });
      return { results, appliedFilters: applied, warnings };
    }

    case 'summarize_candidate': {
      if (!filters['candidateId']) {
        warnings.push('סיכום כרטיס דורש מזהה כרטיס — לא זוהה מזהה בשאלה.');
        return { results: [], appliedFilters: applied, warnings };
      }
      const candidate = await tools.summarizeCandidateTool({
        candidateId: String(filters['candidateId']),
        scope: 'internal',
      });
      if (!candidate) {
        warnings.push(`כרטיס ${filters['candidateId']} לא נמצא.`);
        return { results: [], appliedFilters: applied, warnings };
      }
      return { results: [candidate], appliedFilters: applied, warnings };
    }

    case 'unknown':
    default:
      warnings.push('לא ניתן היה לזהות את כוונת השאלה. נסה לנסח מחדש או לספק מזהה כרטיס.');
      return { results: [], appliedFilters: applied, warnings };
  }
}

// ══════════════════════════════════════════════════════════
// Embeddings (optional abstraction)
// ══════════════════════════════════════════════════════════

export async function embedText(
  text: string,
  options: { userId?: string } = {},
): Promise<AIResponse<EmbeddingResponse>> {
  if (!embeddingsProvider.isAvailable()) {
    throw new AIServiceError('Embeddings provider is not configured', {
      provider: AIProvider.OPENAI,
      fallbackUsed: false,
      retryCount: 0,
      latencyMs: 0,
    });
  }

  const cacheKey = hashKey('embedText', text);
  const cached = cacheGet<EmbeddingResponse>(cacheKey);
  if (cached) {
    return { data: cached.data, metadata: { ...cached.metadata, cached: true } };
  }

  const started = Date.now();
  let success = false;
  let errorMessage: string | undefined;
  let result: EmbeddingResponse | undefined;

  try {
    result = await embeddingsProvider.embed(text);
    success = true;
  } catch (e) {
    errorMessage = (e as Error).message;
  }

  const latencyMs = Date.now() - started;

  await logAIRequest({
    requestType: AIRequestType.EMBED,
    provider: AIProvider.OPENAI,
    model: embeddingsProvider.model,
    inputHash: cacheKey,
    success,
    fallbackUsed: false,
    retryCount: 0,
    latencyMs,
    errorMessage,
    userId: options.userId,
  });

  if (!result) {
    throw new AIServiceError(`embedText failed: ${errorMessage}`, {
      provider: AIProvider.OPENAI,
      fallbackUsed: false,
      retryCount: 0,
      latencyMs,
    });
  }

  const metadata: AIResponseMetadata = {
    provider: AIProvider.OPENAI,
    model: result.model,
    fallbackUsed: false,
    retryCount: 0,
    latencyMs,
    cached: false,
    generatedAt: new Date(),
  };

  cacheSet(cacheKey, result, metadata, 24 * 60 * 60 * 1000); // 24h for embeddings

  return { data: result, metadata };
}
