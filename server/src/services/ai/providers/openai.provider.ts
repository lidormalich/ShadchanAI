// ═══════════════════════════════════════════════════════════
// ShadchanAI — OpenAI Provider (first-class paid engine)
//
// A dedicated OpenAI engine, selectable as the primary via AI_ENGINE,
// or used automatically as the fallback when Groq is the primary.
//
// Keyed by OPENAI_API_KEY (alias: OPENAI). Falls back to the legacy
// FALLBACK_API_KEY so existing setups keep working without edits.
// Model is OPENAI_MODEL (default gpt-4o-mini). Fail-fast timeout/retries
// keep it from hanging for minutes.
// ═══════════════════════════════════════════════════════════

import { AIProvider } from '@shadchanai/shared';
import type {
  AIProviderClient,
  ChatMessage,
  ProviderChatOptions,
  ProviderChatResponse,
} from '../ai.types.js';
import { env } from '../../../config/env.js';
import { AI } from '../../../config/constants.js';
import { OpenAICompatibleClient } from './_openai-compatible.js';

class OpenAIProvider implements AIProviderClient {
  readonly name = AIProvider.OPENAI;
  readonly model: string;
  private readonly client: OpenAICompatibleClient | null;

  constructor() {
    this.model = env.OPENAI_MODEL;
    // Dedicated key first, then the `OPENAI` alias, then the legacy
    // fallback key for backward compatibility.
    const apiKey = env.OPENAI_API_KEY || env.OPENAI || env.FALLBACK_API_KEY;
    if (apiKey) {
      this.client = new OpenAICompatibleClient({
        baseUrl: env.OPENAI_BASE_URL,
        apiKey,
        model: this.model,
        maxRetries: env.OPENAI_MAX_RETRIES,
        backoffBaseMs: AI.BACKOFF_BASE_MS,
        timeoutMs: env.OPENAI_TIMEOUT_MS,
      });
    } else {
      this.client = null;
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async chat(messages: ChatMessage[], options?: ProviderChatOptions): Promise<ProviderChatResponse> {
    if (!this.client) {
      throw new Error('OpenAI provider is not configured (OPENAI_API_KEY missing)');
    }
    return this.client.chatCompletion(messages, options);
  }
}

export const openaiProvider: AIProviderClient = new OpenAIProvider();
