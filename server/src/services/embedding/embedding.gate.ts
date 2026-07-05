// ═══════════════════════════════════════════════════════════
// ShadchanAI — Semantic matching runtime gate
//
// Single source of truth for "is the semantic (embeddings) add-on
// active right now?". Two conditions must hold:
//
//   1. The admin toggled `matching.semantic_enabled` ON in Settings
//      (persisted, cached ~5min, write-invalidated — flips at runtime
//      without a deploy; env EMBEDDINGS_ENABLED is only the default).
//   2. An embeddings API key is configured (OpenAI or HuggingFace) —
//      otherwise the toggle is inert and we warn once instead of
//      failing every scoring call.
//
// Every embedding-touching entry point (chunk generation, similarity
// computation, Atlas search) must consult this gate, so turning the
// setting off immediately reverts matching to the deterministic
// engine only.
// ═══════════════════════════════════════════════════════════

import { env } from '../../config/env.js';
import { getSettingCached } from '../../modules/settings/settings.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('embedding.gate');

/** True when some embeddings-capable API key exists in the environment. */
export function isEmbeddingConfigured(): boolean {
  return Boolean(
    env.EMBEDDINGS_ENDPOINT_URL
    || env.EMBEDDINGS_API_KEY
    || env.OPENAI_API_KEY
    || env.FALLBACK_API_KEY,
  );
}

let warnedNotConfigured = false;

/**
 * Runtime check: admin toggle ON + a provider key configured.
 * Cheap to call in hot paths (setting reads are TTL-cached).
 */
export async function isSemanticEnabled(): Promise<boolean> {
  const enabled = (await getSettingCached('matching.semantic_enabled')) === true;
  if (!enabled) return false;

  if (!isEmbeddingConfigured()) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      log.warn(
        'matching.semantic_enabled is ON but no embeddings API key is configured '
        + '(set OPENAI_API_KEY or EMBEDDINGS_API_KEY/EMBEDDINGS_ENDPOINT_URL) — semantic matching stays off',
      );
    }
    return false;
  }
  return true;
}
