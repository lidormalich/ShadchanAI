// ═══════════════════════════════════════════════════════════
// ShadchanAI — AI Router
//
// HTTP endpoints for every AI method. All inputs are validated
// via Zod before reaching the service. All errors produce a
// structured response envelope with the AIResponseMetadata
// available for audit.
// ═══════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';

import {
  explainMatch,
  generateMessage,
  summarizeCandidate,
  classifyMessage,
  suggestNextStep,
  askAI,
  embedText,
  AIServiceError,
} from './ai.service.js';
import { extractProfileFromText } from '../extraction/profile.extractor.js';

import {
  ExplainMatchInputSchema,
  GenerateMessageInputSchema,
  SummarizeCandidateInputSchema,
  ClassifyMessageInputSchema,
  SuggestNextStepInputSchema,
  AskAIInputSchema,
} from './ai.validators.js';

import type {
  ExplainMatchInput,
  GenerateMessageInput,
  SummarizeCandidateInput,
  ClassifyMessageInput,
  SuggestNextStepInput,
  AskAIInput,
} from './ai.types.js';

export const aiRouter = Router();

// ── Error/success helpers ────────────────────────────────

function sendSuccess<T>(res: Response, data: T, meta?: unknown): void {
  res.status(200).json({ success: true, data, meta });
}

function sendError(res: Response, status: number, message: string, details?: unknown): void {
  res.status(status).json({ success: false, error: message, details });
}

async function runHandler<TInput, TOutput>(
  req: Request,
  res: Response,
  schema: z.ZodType<TInput>,
  handler: (input: TInput, userId?: string) => Promise<{ data: TOutput; metadata: unknown }>,
): Promise<void> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, 'Invalid request body', parsed.error.issues);
    return;
  }

  const userId = (req as Request & { user?: { id?: string } }).user?.id;

  try {
    const result = await handler(parsed.data, userId);
    sendSuccess(res, result.data, result.metadata);
  } catch (err) {
    if (err instanceof AIServiceError) {
      sendError(res, 502, err.message, err.info);
    } else {
      sendError(res, 500, (err as Error).message);
    }
  }
}

// ── Routes ───────────────────────────────────────────────

aiRouter.post('/explain-match', (req, res) => {
  void runHandler(req, res, ExplainMatchInputSchema, (input, userId) =>
    explainMatch(input as unknown as ExplainMatchInput, { userId }),
  );
});

aiRouter.post('/generate-message', (req, res) => {
  void runHandler(req, res, GenerateMessageInputSchema, (input, userId) =>
    generateMessage(input as unknown as GenerateMessageInput, { userId }),
  );
});

aiRouter.post('/summarize-candidate', (req, res) => {
  void runHandler(req, res, SummarizeCandidateInputSchema, (input, userId) =>
    summarizeCandidate(input as unknown as SummarizeCandidateInput, { userId }),
  );
});

aiRouter.post('/classify-message', (req, res) => {
  void runHandler(req, res, ClassifyMessageInputSchema, (input, userId) =>
    classifyMessage(input as unknown as ClassifyMessageInput, { userId }),
  );
});

aiRouter.post('/suggest-next-step', (req, res) => {
  void runHandler(req, res, SuggestNextStepInputSchema, (input, userId) =>
    suggestNextStep(input as unknown as SuggestNextStepInput, { userId }),
  );
});

aiRouter.post('/ask', (req, res) => {
  void runHandler(req, res, AskAIInputSchema, (input, userId) =>
    askAI({ ...(input as AskAIInput), userId: (input as AskAIInput).userId ?? userId }),
  );
});

// Extract candidate fields from a free-text profile card (one smart
// service for both internal & external intake forms — each form maps
// the returned superset to its own shape). `target` is advisory only:
// it tags the AI audit log with the entity type.
aiRouter.post('/extract-profile', async (req, res) => {
  const { text, target } = req.body as { text?: unknown; target?: unknown };
  if (typeof text !== 'string' || text.trim().length === 0) {
    sendError(res, 400, 'text is required and must be a non-empty string');
    return;
  }
  if (text.length > 8000) {
    sendError(res, 400, 'text is too long (max 8000 characters)');
    return;
  }

  const relatedEntityType = target === 'external' ? 'external_candidate' : 'internal_candidate';
  const userId = (req as Request & { user?: { id?: string } }).user?.id;
  try {
    const result = await extractProfileFromText(text, { userId, relatedEntityType });
    sendSuccess(res, result.profile, {
      provider: result.providerUsed,
      fallbackUsed: result.fallbackUsed,
      latencyMs: result.latencyMs,
    });
  } catch (err) {
    if (err instanceof AIServiceError) {
      sendError(res, 502, err.message, err.info);
    } else {
      sendError(res, 500, (err as Error).message);
    }
  }
});

aiRouter.post('/embed', async (req, res) => {
  const { text } = req.body as { text?: unknown };
  if (typeof text !== 'string' || text.trim().length === 0) {
    sendError(res, 400, 'text is required and must be a non-empty string');
    return;
  }

  const userId = (req as Request & { user?: { id?: string } }).user?.id;
  try {
    const result = await embedText(text, { userId });
    // Don't send the raw vector back through HTTP by default — too large.
    // Return dimensions + model + a hash-style indicator instead.
    sendSuccess(res, {
      dimensions: result.data.dimensions,
      model: result.data.model,
      vectorLength: result.data.vector.length,
    }, result.metadata);
  } catch (err) {
    if (err instanceof AIServiceError) {
      sendError(res, 502, err.message, err.info);
    } else {
      sendError(res, 500, (err as Error).message);
    }
  }
});
