// ═══════════════════════════════════════════════════════════
// ShadchanAI — Embeddings Provider
//
// Provider-agnostic scaffolding for text embeddings. Uses the
// OpenAI-compatible /v1/embeddings endpoint by default.
//
// Optional: the engine consumes embeddings as an input (semantic
// similarity) but does not compute them. This provider lets
// offline jobs backfill embeddings on candidate profiles.
// ═══════════════════════════════════════════════════════════

import type { EmbeddingProviderClient, EmbeddingResponse } from '../ai.types.js';
import { env } from '../../../config/env.js';

class EmbeddingsProvider implements EmbeddingProviderClient {
  readonly name: string;
  readonly model: string;
  private readonly apiKey: string | null;
  private readonly baseUrl: string;

  constructor() {
    // Reuse fallback provider config by default. Allow dedicated embeddings env too.
    this.name = env.EMBEDDINGS_PROVIDER ?? env.FALLBACK_PROVIDER;
    this.model = env.EMBEDDINGS_MODEL ?? 'text-embedding-3-small';
    this.apiKey = env.EMBEDDINGS_API_KEY ?? env.FALLBACK_API_KEY ?? null;
    this.baseUrl = env.FALLBACK_BASE_URL; // typically https://api.openai.com/v1
  }

  isAvailable(): boolean {
    return this.apiKey !== null;
  }

  async embed(text: string): Promise<EmbeddingResponse> {
    if (!this.apiKey) {
      throw new Error('Embeddings provider is not configured');
    }
    if (!text || !text.trim()) {
      throw new Error('Cannot embed empty text');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Embeddings provider error ${response.status}: ${errBody}`);
      }

      const data = await response.json() as {
        data?: Array<{ embedding?: number[] }>;
        model?: string;
      };

      const vector = data.data?.[0]?.embedding;
      if (!vector || !Array.isArray(vector) || vector.length === 0) {
        throw new Error('Embeddings provider returned empty vector');
      }

      return {
        vector,
        model: data.model ?? this.model,
        dimensions: vector.length,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const embeddingsProvider: EmbeddingProviderClient = new EmbeddingsProvider();
