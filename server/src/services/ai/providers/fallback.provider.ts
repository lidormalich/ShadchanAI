// ═══════════════════════════════════════════════════════════
// ShadchanAI — Fallback Provider (Secondary)
//
// A second stable low-cost provider used when Groq:
//   - fails with a provider error
//   - produces unvalidated output after retry
//   - is unavailable (rate-limited, unconfigured)
//
// Default: OpenAI gpt-4o-mini (reliable, cheap, OpenAI-compatible).
// Configurable via FALLBACK_PROVIDER / FALLBACK_BASE_URL / FALLBACK_MODEL.
//
// The same OpenAI-compatible shape lets us reuse the base client.
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

class FallbackProvider implements AIProviderClient {
  readonly name: AIProvider;
  readonly model: string;
  private readonly client: OpenAICompatibleClient | null;

  constructor() {
    // Map env string to AIProvider enum
    this.name = env.FALLBACK_PROVIDER === 'anthropic'
      ? AIProvider.ANTHROPIC
      : AIProvider.OPENAI;
    this.model = env.FALLBACK_MODEL;

    if (env.FALLBACK_API_KEY) {
      this.client = new OpenAICompatibleClient({
        baseUrl: env.FALLBACK_BASE_URL,
        apiKey: env.FALLBACK_API_KEY,
        model: this.model,
        maxRetries: AI.MAX_RETRIES,
        backoffBaseMs: AI.BACKOFF_BASE_MS,
        timeoutMs: 45_000, // fallback gets a bit more patience
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
      throw new Error('Fallback provider is not configured (FALLBACK_API_KEY missing)');
    }
    return this.client.chatCompletion(messages, options);
  }
}

export const fallbackProvider: AIProviderClient = new FallbackProvider();
