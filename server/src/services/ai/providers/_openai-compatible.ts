// ═══════════════════════════════════════════════════════════
// ShadchanAI — Shared OpenAI-Compatible Client
//
// Groq, OpenAI, and many other providers expose the same
// /v1/chat/completions format. This shared client handles
// the protocol; Groq and fallback providers extend it with
// their specific base URLs, keys, and models.
//
// Includes:
//   - Timeout-aware fetch
//   - Exponential backoff retry for 429/5xx
//   - Honor Retry-After header
//   - Token usage extraction
// ═══════════════════════════════════════════════════════════

import type { ChatMessage, ProviderChatOptions, ProviderChatResponse } from '../ai.types.js';

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Timeout per request (ms) */
  timeoutMs?: number;
  /** Max retries on 429/5xx */
  maxRetries?: number;
  /** Exponential backoff base */
  backoffBaseMs?: number;
}

export class OpenAICompatibleClient {
  constructor(protected readonly config: OpenAICompatibleConfig) {}

  async chatCompletion(
    messages: ChatMessage[],
    options: ProviderChatOptions = {},
  ): Promise<ProviderChatResponse> {
    const {
      temperature = 0.3,
      maxTokens = 1200,
      jsonMode = true,
    } = options;

    const maxRetries = this.config.maxRetries ?? 3;
    const backoffBase = this.config.backoffBaseMs ?? 1000;
    const timeoutMs = this.config.timeoutMs ?? 30_000;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const body: Record<string, unknown> = {
          model: this.config.model,
          messages,
          temperature,
          max_tokens: maxTokens,
        };
        if (jsonMode) {
          body['response_format'] = { type: 'json_object' };
        }

        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
          const delayMs = retryAfter ?? backoffBase * Math.pow(2, attempt);
          if (attempt < maxRetries) {
            await sleep(delayMs);
            continue;
          }
          const errorBody = await safeReadText(response);
          throw new Error(`Provider error ${response.status}: ${errorBody}`);
        }

        if (!response.ok) {
          const errorBody = await safeReadText(response);
          throw new Error(`Provider error ${response.status}: ${errorBody}`);
        }

        const data = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          model?: string;
        };

        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('Provider returned empty content');
        }

        return {
          content,
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
          model: data.model ?? this.config.model,
        };
      } catch (err) {
        clearTimeout(timeout);
        lastError = err as Error;
        // AbortError → treat as retry-worthy timeout
        if ((err as Error).name === 'AbortError') {
          if (attempt < maxRetries) {
            await sleep(backoffBase * Math.pow(2, attempt));
            continue;
          }
        }
        // Non-retry errors: rethrow immediately (auth errors, etc.)
        if (!isRetryableError(err as Error)) {
          throw err;
        }
        if (attempt < maxRetries) {
          await sleep(backoffBase * Math.pow(2, attempt));
          continue;
        }
      }
    }

    throw lastError ?? new Error('Provider request failed');
  }
}

// ── Helpers ───────────────────────────────────────────────

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n)) return n * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeReadText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return '<unreadable response body>';
  }
}

function isRetryableError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  // Network errors, timeouts, 429, 5xx
  if (msg.includes('429')) return true;
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
  if (msg.includes('timeout') || err.name === 'AbortError') return true;
  if (msg.includes('econnreset') || msg.includes('enotfound')) return true;
  return false;
}
