// ═══════════════════════════════════════════════════════════
// ShadchanAI — Embedding Provider
//
// HTTP client for the HuggingFace Inference API (bge-m3).
// Supports both:
//   • HF Dedicated Endpoints  (EMBEDDINGS_ENDPOINT_URL set)
//   • HF Serverless Inference (no endpoint URL — uses model ID)
//
// Responsibilities:
//   • Batch texts → vectors via the HF REST API.
//   • Retry transient failures (503 model-loading, 429 rate-limit).
//   • Validate response shape and dimensions.
//   • Never swallow errors — callers decide how to handle them.
//
// NOT responsible for DB reads/writes or chunk lifecycle.
// ═══════════════════════════════════════════════════════════

import { env } from '../../config/env.js';
import type { EmbeddingModelConfig } from './embedding.types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('embedding.provider');

// ── Constants ─────────────────────────────────────────────

/** Maximum texts per API call.  bge-m3 handles large batches well,
 *  but we stay conservative to avoid OOM on the HF endpoint. */
const MAX_BATCH_SIZE = 32;

/** Retry budget for transient errors. */
const MAX_RETRIES = 3;

/** Base delay (ms) for exponential back-off between retries. */
const RETRY_BASE_MS = 1_000;

// ── Types ─────────────────────────────────────────────────

/** Public interface.  Swap the HuggingFace implementation for a
 *  local ONNX runner or another provider without changing callers. */
export interface IEmbeddingProvider {
  /** Embed a batch of texts.  Returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
  /** Stable identifier stored in the DB for cache-invalidation. */
  readonly modelConfig: EmbeddingModelConfig;
}

// ── HuggingFace provider ──────────────────────────────────

class HuggingFaceEmbeddingProvider implements IEmbeddingProvider {
  readonly modelConfig: EmbeddingModelConfig;

  private readonly apiUrl: string;
  private readonly authHeader: string;

  constructor() {
    const modelId    = env.EMBEDDINGS_MODEL    ?? 'BAAI/bge-m3';
    const provider   = 'huggingface';
    const dimensions = env.EMBEDDINGS_DIMENSIONS ?? 1024;

    this.modelConfig = { modelId, provider, dimensions };

    // Dedicated Endpoint takes priority over Serverless so operators
    // can switch between them purely through environment variables.
    this.apiUrl = env.EMBEDDINGS_ENDPOINT_URL
      ?? `https://api-inference.huggingface.co/models/${modelId}`;

    const apiKey = env.EMBEDDINGS_API_KEY ?? env.FALLBACK_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[embedding.provider] No API key found. ' +
        'Set EMBEDDINGS_API_KEY or FALLBACK_API_KEY in your environment.',
      );
    }
    this.authHeader = `Bearer ${apiKey}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Split into batches to respect the per-request size limit.
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      batches.push(texts.slice(i, i + MAX_BATCH_SIZE));
    }

    const results: number[][] = [];
    for (const batch of batches) {
      const vectors = await this.embedBatchWithRetry(batch);
      results.push(...vectors);
    }
    return results;
  }

  // ── Private ──────────────────────────────────────────────

  private async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.embedBatch(texts);
      } catch (err) {
        lastError = err;

        if (!isRetryableError(err)) {
          // Non-transient errors (400 bad request, auth failures, etc.)
          // bubble up immediately — no point retrying.
          throw err;
        }

        const delayMs = RETRY_BASE_MS * 2 ** attempt;
        const reason  = err instanceof EmbeddingApiError ? `HTTP ${err.status}` : String(err);
        log.warn({ attempt: attempt + 1, delayMs, reason }, 'retry');
        await sleep(delayMs);
      }
    }

    throw lastError;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const startedAt = Date.now();

    const response = await fetch(this.apiUrl, {
      method:  'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ inputs: texts }),
    });

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new EmbeddingApiError(response.status, body, latencyMs);
    }

    const raw: unknown = await response.json();
    const vectors = normaliseApiResponse(raw, this.modelConfig.dimensions);

    log.info({
      batchSize: texts.length,
      dimensions: this.modelConfig.dimensions,
      latencyMs,
    }, 'embed_batch');

    return vectors;
  }
}

// ── Response normalisation ────────────────────────────────
//
// The HuggingFace Inference API can return embeddings in two shapes
// depending on how the model is served:
//
//   Shape A (feature-extraction pipeline, most common):
//     number[][]  — one vector per input
//
//   Shape B (some older endpoints):
//     Array<{ embedding: number[] }>
//
// We normalise to number[][] and validate that each vector has the
// expected number of dimensions.

function normaliseApiResponse(raw: unknown, expectedDimensions: number): number[][] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `[embedding.provider] Unexpected API response shape: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }

  let vectors: number[][];

  if (typeof raw[0] === 'number') {
    // Single embedding returned as a flat array (single-input request).
    vectors = [raw as number[]];
  } else if (Array.isArray(raw[0])) {
    // Standard batch response: number[][]
    vectors = raw as number[][];
  } else if (typeof raw[0] === 'object' && raw[0] !== null && 'embedding' in raw[0]) {
    // Older format: Array<{ embedding: number[] }>
    vectors = (raw as Array<{ embedding: number[] }>).map(r => r.embedding);
  } else {
    throw new Error(
      `[embedding.provider] Unrecognised API response element type: ` +
      `${JSON.stringify(raw[0]).slice(0, 100)}`,
    );
  }

  // Validate dimensions on the first vector only (cheap sanity check).
  const firstVector = vectors[0];
  if (!firstVector) {
    throw new Error('[embedding.provider] API returned an empty vector array.');
  }
  if (firstVector.length !== expectedDimensions) {
    throw new Error(
      `[embedding.provider] Dimension mismatch: expected ${expectedDimensions}, ` +
      `got ${firstVector.length}. Did you change EMBEDDINGS_MODEL without updating ` +
      `EMBEDDINGS_DIMENSIONS or the Atlas vector index?`,
    );
  }

  return vectors;
}

// ── Error types ───────────────────────────────────────────

class EmbeddingApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly latencyMs: number,
  ) {
    super(`HuggingFace API error ${status}: ${body.slice(0, 300)}`);
    this.name = 'EmbeddingApiError';
  }
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof EmbeddingApiError) {
    // 503 = model still loading (common on cold Dedicated Endpoints)
    // 429 = rate limited
    // 500/502/504 = transient server errors
    return [429, 500, 502, 503, 504].includes(err.status);
  }
  // Network-level errors (ECONNRESET, fetch failures) are also retryable.
  return true;
}

// ── Utilities ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Singleton factory ─────────────────────────────────────
//
// Instantiated lazily so the provider is only created when
// EMBEDDINGS_ENABLED=true — avoids crashing the server at boot
// if the API key is missing but embeddings are disabled.

let _provider: IEmbeddingProvider | null = null;

export function getEmbeddingProvider(): IEmbeddingProvider {
  if (!_provider) {
    _provider = new HuggingFaceEmbeddingProvider();
  }
  return _provider;
}

/** Resets the singleton — used in tests to inject a mock provider. */
export function _resetProviderForTesting(mock?: IEmbeddingProvider): void {
  _provider = mock ?? null;
}
