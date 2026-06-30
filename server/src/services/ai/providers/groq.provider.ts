// ═══════════════════════════════════════════════════════════
// ShadchanAI — Groq Provider (Primary)
//
// Groq exposes an OpenAI-compatible chat completions endpoint.
// This provider wraps that protocol with our types and env.
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

class GroqProvider implements AIProviderClient {
  readonly name = AIProvider.GROQ;
  readonly model: string;
  private readonly client: OpenAICompatibleClient | null;

  constructor() {
    this.model = env.GROQ_MODEL;
    if (env.GROQ_API_KEY) {
      this.client = new OpenAICompatibleClient({
        baseUrl: env.GROQ_BASE_URL,
        apiKey: env.GROQ_API_KEY,
        model: this.model,
        // Fail fast → the fallback (OpenAI) engages quickly when Groq
        // hangs or rate-limits. Tunable via GROQ_MAX_RETRIES/GROQ_TIMEOUT_MS.
        maxRetries: env.GROQ_MAX_RETRIES,
        backoffBaseMs: AI.BACKOFF_BASE_MS,
        timeoutMs: env.GROQ_TIMEOUT_MS,
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
      throw new Error('Groq provider is not configured (GROQ_API_KEY missing)');
    }
    return this.client.chatCompletion(messages, options);
  }
}

export const groqProvider: AIProviderClient = new GroqProvider();
