// ═══════════════════════════════════════════════════════════
// App-wide constants — limits, defaults, config values
// ═══════════════════════════════════════════════════════════

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 25,
  MAX_LIMIT: 100,
} as const;

export const MATCHING = {
  /** Default weights for the 8 scoring dimensions (must sum to 1.0) */
  DEFAULT_WEIGHTS: {
    age: 0.15,
    sector: 0.15,
    lifestyle: 0.15,
    study_work: 0.10,
    location: 0.10,
    mutual_expectations: 0.15,
    life_stage: 0.10,
    flexibility: 0.10,
  },
  /** matchType thresholds */
  SAFE_MIN_MATCH_SCORE: 80,
  SAFE_MIN_CONFIDENCE: 70,
  BALANCED_MIN_MATCH_SCORE: 60,
  BALANCED_MIN_CONFIDENCE: 50,
  CREATIVE_MIN_MATCH_SCORE: 40,
  /** Max results per mode */
  STRICT_MAX_RESULTS: 15,
  DISCOVERY_MAX_RESULTS: 30,
} as const;

export const AI = {
  MAX_RETRIES: 3,
  BACKOFF_BASE_MS: 1000,
  CACHE_TTL_MS: 5 * 60 * 1000,
  MAX_PROMPT_LENGTH: 8000,
  RATE_LIMIT_PER_MINUTE: 20,
} as const;

export const WHATSAPP = {
  /** Must respond to webhook within this time */
  WEBHOOK_TIMEOUT_MS: 5000,
} as const;

// Embedding dimensions are stored per-document in the embedding sub-schema
// (provider, modelId, version, dimensions) to support multi-provider flexibility.
// No hard-coded dimension constant — the schema adapts to whichever provider is used.
