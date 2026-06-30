// ═══════════════════════════════════════════════════════════
// ShadchanAI — AI Output Validators
//
// Zod schemas for every AI method's structured output.
// Every provider response is parsed and validated through
// these schemas BEFORE it's returned to callers. If validation
// fails, the orchestrator retries, then falls back, then errors.
//
// These are STRICT schemas: required fields must be present and
// non-empty for critical text fields; arrays must be arrays;
// types must match. Silently-empty critical strings are rejected.
// ═══════════════════════════════════════════════════════════

import { z } from 'zod';

// ── Helper: non-empty trimmed string ─────────────────────

const nonEmptyString = z.string().trim().min(1);

// ── explainMatch ─────────────────────────────────────────

export const ExplainMatchOutputSchema = z.object({
  summary: nonEmptyString.max(2000),
  strengths: z.array(z.string().trim().min(1)).max(10).default([]),
  concerns: z.array(z.string().trim().min(1)).max(10).default([]),
  nuance: z.string().trim().max(2000).default(''),
  recommendedApproach: nonEmptyString.max(1000),
  notMatchReasons: z.array(z.string().trim().min(1)).max(10).default([]),
});

// ── generateMessage ──────────────────────────────────────

export const GenerateMessageOutputSchema = z.object({
  message: nonEmptyString.max(2000),
  tone: z.string().trim().default('warm'),
  language: z.string().trim().default('he'),
  reviewFlags: z.array(z.string().trim()).max(10).default([]),
});

// ── summarizeCandidate ───────────────────────────────────

export const SummarizeCandidateOutputSchema = z.object({
  summary: nonEmptyString.max(2000),
  personalityTraits: z.array(z.string().trim().min(1)).max(15).default([]),
  values: z.array(z.string().trim().min(1)).max(15).default([]),
  communicationStyle: z.string().trim().max(500).default(''),
  warnings: z.array(z.string().trim().min(1)).max(10).default([]),
});

// ── classifyMessage ──────────────────────────────────────

export const ClassifyMessageOutputSchema = z.object({
  intent: nonEmptyString.max(100),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed', 'unknown']).default('unknown'),
  language: nonEmptyString.max(20),
  urgency: z.enum(['low', 'normal', 'high']).default('normal'),
  actionNeeded: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0.5),
});

// ── suggestNextStep ──────────────────────────────────────

export const SuggestNextStepOutputSchema = z.object({
  action: nonEmptyString.max(200),
  reason: nonEmptyString.max(1000),
  urgency: z.enum(['low', 'normal', 'high']).default('normal'),
  alternatives: z.array(z.string().trim().min(1)).max(5).default([]),
});

// ── Ask AI ───────────────────────────────────────────────

export const AskAIIntentSchema = z.enum([
  'find_matching_candidates',
  'find_unhandled_candidates',
  'find_high_potential_matches',
  'find_stale_candidates',
  'find_similar_candidates',
  'find_active_issues',
  'summarize_candidate',
  'unknown',
]);

export const AskAIIntentDetectionSchema = z.object({
  intent: AskAIIntentSchema,
  filters: z.object({
    candidateId: z.string().optional(),
    sectorGroup: z.string().optional(),
    subSector: z.string().optional(),
    city: z.string().optional(),
    ageMin: z.number().int().positive().optional(),
    ageMax: z.number().int().positive().optional(),
    mode: z.enum(['strict', 'discovery']).optional(),
    matchType: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
    daysSinceAction: z.number().int().nonnegative().optional(),
  }).default({}),
  reasoning: z.string().trim().max(1000).default(''),
});

export const AskAIOutputSchema = z.object({
  intent: AskAIIntentSchema,
  appliedFilters: z.record(z.unknown()).default({}),
  results: z.array(z.unknown()).default([]),
  reasoningSummary: z.string().trim().max(2000).default(''),
  recommendedActions: z.array(z.string().trim().min(1)).max(10).default([]),
  warnings: z.array(z.string().trim().min(1)).max(10).default([]),
});

// ── Input validators (for router) ────────────────────────

export const ExplainMatchInputSchema = z.object({
  internal: z.record(z.unknown()),
  external: z.record(z.unknown()),
  matchScore: z.number().min(0).max(100),
  confidenceScore: z.number().min(0).max(100),
  matchType: nonEmptyString,
  riskLevel: nonEmptyString,
  strengths: z.array(z.string()).default([]),
  attentionPoints: z.array(z.string()).default([]),
  scoreBreakdown: z.array(z.object({
    dimension: z.string(),
    score: z.number(),
    detail: z.string(),
  })).default([]),
});

export const GenerateMessageInputSchema = z.object({
  purpose: z.enum(['intro', 'follow_up', 'decline', 'scheduling', 'general']),
  recipient: z.record(z.unknown()),
  aboutCandidate: z.record(z.unknown()).optional(),
  tone: z.enum(['warm', 'formal', 'concise', 'respectful']).default('warm'),
  language: z.enum(['he', 'en']).default('he'),
  additionalContext: z.string().max(2000).optional(),
  constraints: z.array(z.string()).max(10).optional(),
});

export const SummarizeCandidateInputSchema = z.object({
  candidate: z.record(z.unknown()),
});

export const ClassifyMessageInputSchema = z.object({
  text: nonEmptyString.max(5000),
  context: z.object({
    purpose: z.string().optional(),
    previousMessages: z.array(z.string()).max(20).optional(),
  }).optional(),
});

export const SuggestNextStepInputSchema = z.object({
  matchStatus: nonEmptyString,
  matchType: nonEmptyString,
  recommendedAction: nonEmptyString,
  daysSinceLastAction: z.number().int().nonnegative().optional(),
  sideAResponse: z.string().optional(),
  sideBResponse: z.string().optional(),
  ownerNote: z.string().max(1000).optional(),
});

export const AskAIInputSchema = z.object({
  query: nonEmptyString.max(2000),
  userId: z.string().optional(),
  forceIntent: AskAIIntentSchema.optional(),
});

// ── Runtime parser with structured error ─────────────────

export interface ValidationResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Attempt to parse raw JSON content into the target schema.
 * Returns { ok, data } on success or { ok: false, error } on failure.
 * Rejects non-JSON, malformed, missing-required-field, or type-mismatch content.
 */
export function parseAndValidate<T>(
  rawContent: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): ValidationResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawContent));
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
    ).join('; ');
    return { ok: false, error: `Schema validation failed: ${issues}` };
  }

  return { ok: true, data: result.data };
}

/**
 * Strip common provider artifacts (markdown code fences, leading/trailing
 * prose) and return the JSON substring.
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();

  // Remove ```json ... ``` or ``` ... ``` code fences
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  // Find the first `{` and matching last `}`
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  // Find the first `[` and matching last `]` (array root)
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return trimmed.slice(firstBracket, lastBracket + 1);
  }

  return trimmed;
}
