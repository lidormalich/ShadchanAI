// ═══════════════════════════════════════════════════════════
// ShadchanAI — AI Request Logger
//
// Writes every AI request to the AIRequest collection for
// auditability, pattern analysis, and cost/performance
// monitoring. Also emits a structured console log.
//
// Logging is best-effort: failures here never propagate back
// to the caller (never break an AI flow due to logging).
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { AIRequest } from '../../models/index.js';
import type { AILogRecord } from './ai.types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ai');

export async function logAIRequest(record: AILogRecord): Promise<void> {
  // Best-effort: never throw from here
  try {
    await AIRequest.create({
      requestType: record.requestType,
      provider: record.provider,
      modelId: record.model,
      inputHash: record.inputHash,
      success: record.success,
      fallbackUsed: record.fallbackUsed,
      fallbackProvider: record.fallbackProvider,
      retryCount: record.retryCount,
      latencyMs: record.latencyMs,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      errorMessage: record.errorMessage,
      errorCode: record.errorCode,
      userId: record.userId ? new Types.ObjectId(record.userId) : undefined,
      relatedEntityType: record.relatedEntityType,
      relatedEntityId: record.relatedEntityId ? new Types.ObjectId(record.relatedEntityId) : undefined,
    });
  } catch (err) {
    log.error({ err }, 'Failed to persist AIRequest');
  }

  // Structured log for immediate visibility
  const fields = {
    requestType: record.requestType,
    provider: record.provider,
    model: record.model,
    fallback: record.fallbackUsed,
    retries: record.retryCount,
    latencyMs: record.latencyMs,
    success: record.success,
    ...(record.errorMessage ? { error: record.errorMessage } : {}),
  };
  if (record.success) {
    log.info(fields, 'ai_request');
  } else {
    log.warn(fields, 'ai_request');
  }
}
