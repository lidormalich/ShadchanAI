import { z } from 'zod';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { booleanString } from '../utils/zod-bool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });
dotenv.config();

/**
 * Optional string env var that treats placeholder values as "unset".
 *
 * An operator who leaves the literal `NOT SET` (the value shipped in the
 * .env templates) — or blank/whitespace — means "I have not configured this",
 * NOT "use the string 'NOT SET' as my API key". Without this normalization a
 * placeholder is a truthy value: the provider builds a client and sends
 * `NOT SET` as the key, getting a 401 on every request instead of cleanly
 * reporting itself unavailable and being skipped.
 */
const optionalConfig = () =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    if (trimmed === '' || trimmed.toUpperCase() === 'NOT SET') return undefined;
    return trimmed;
  }, z.string().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // ── Security / auth ──────────────────────────────────
  /** Must be at least 32 chars in production. Used to sign JWTs. */
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),

  /** Comma-separated list of allowed CORS origins */
  CORS_ORIGINS: z.string().default('http://localhost:5175'),

  /** Dev-only auth fallback: accept X-Dev-User header. Never set true in production. */
  AUTH_DEV_HEADER_ALLOWED: booleanString(false),

  /** Request body size limit */
  BODY_LIMIT: z.string().default('2mb'),

  /**
   * When set, Express serves the built client SPA (static assets + index.html
   * fallback for non-/api routes) from this directory. This makes the client
   * and API same-origin, which the client REQUIRES — it calls a hardcoded
   * relative `/api`. Leave unset in local dev (Vite dev server proxies /api).
   * In the Docker image this points at the copied client `dist/`.
   */
  CLIENT_DIST_DIR: z.string().optional(),

  // ── Database ─────────────────────────────────────────
  MONGODB_URI: z.string().min(1),

  // ── AI engine selection ──────────────────────────────
  // Which provider is the PRIMARY. Default 'groq' (free/fast). Switch to
  // 'openai' (paid) per environment. The other engine auto-serves as the
  // fallback when it has a key.
  AI_ENGINE: z.enum(['groq', 'openai']).default('groq'),

  // ── Groq AI (free tier) ──────────────────────────────
  GROQ_API_KEY: optionalConfig(),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),
  // Fail FAST so a hung/rate-limited Groq hands off in seconds, not minutes.
  GROQ_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  GROQ_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),

  // ── OpenAI (paid engine) ─────────────────────────────
  // Dedicated OpenAI token + model. `OPENAI` is accepted as an alias for
  // OPENAI_API_KEY; the legacy FALLBACK_API_KEY is used as a last resort
  // so existing setups keep working.
  OPENAI_API_KEY: optionalConfig(),
  OPENAI: optionalConfig(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),

  // ── Legacy fallback (kept for backward compat) ───────
  FALLBACK_PROVIDER: z.enum(['openai', 'anthropic']).default('openai'),
  FALLBACK_API_KEY: optionalConfig(),
  FALLBACK_MODEL: z.string().default('gpt-4o-mini'),
  FALLBACK_BASE_URL: z.string().default('https://api.openai.com/v1'),

  // ── WhatsApp (Baileys — session-based) ───────────────
  // Each channel maps to one Baileys session stored on disk.
  // The directory contains the auth state (credentials + pre-keys).
  // Its contents are AS SENSITIVE AS the WhatsApp session itself:
  //   - never log its contents
  //   - never expose over the API
  //   - file permissions 0600 recommended
  //   - exclude from public backups or encrypt at rest
  WA_SESSIONS_DIR: z.string().default('./data/wa-sessions'),

  // Optional display-name defaults per role — only used as a fallback
  // when an operator creates a channel via a seed/script path.
  WA_PROFILES_SOURCE_DISPLAY_NAME: z.string().optional(),
  WA_MATCH_SENDING_DISPLAY_NAME: z.string().optional(),

  // If true, on boot the server auto-starts Baileys sessions for every
  // non-replaced / non-disconnected channel. Safe for single-instance.
  // For multi-instance deployments this must be disabled and sessions
  // must be owned by one process (see deployment notes).
  WA_AUTO_START_SESSIONS: booleanString(true),

  // Stable identity used as the owner of channel-level locks
  // (Channel.ownerInstanceId). When set, a restarted process can
  // immediately reclaim its own previously-held locks instead of
  // waiting for the stale window. Falls back to HOSTNAME and then
  // a random UUID — see services/whatsapp/instance.lock.ts.
  WA_INSTANCE_ID: z.string().min(1).optional(),

  // ── Embeddings ───────────────────────────────────────
  // Master switch. When false the embedding service is a no-op and
  // the similarity pre-filter is bypassed (board returns all candidates
  // exactly as before). Flip to true only after Atlas indexes + HF
  // endpoint are configured and backfill has completed.
  EMBEDDINGS_ENABLED: booleanString(false),

  EMBEDDINGS_PROVIDER: optionalConfig(),
  EMBEDDINGS_API_KEY:  optionalConfig(),

  // HuggingFace Dedicated Endpoint URL.  When set, used instead of the
  // public Serverless Inference API.  Recommended for production.
  // Example: https://xxx.aws.endpoints.huggingface.cloud
  EMBEDDINGS_ENDPOINT_URL: z.string().url().optional(),

  // bge-m3 = 'BAAI/bge-m3' (Phase 1); bge-multilingual-gemma2 (Phase 2)
  EMBEDDINGS_MODEL: optionalConfig(),

  // Must match the Atlas vector index numDimensions.
  // bge-m3 → 1024 | bge-multilingual-gemma2 → 3584
  EMBEDDINGS_DIMENSIONS: z.coerce.number().int().positive().default(1024),

  // How many candidates the Atlas $rankFusion returns before the engine runs.
  SEMANTIC_TOP_K: z.coerce.number().int().positive().default(150),

  // ── Rate limiting ────────────────────────────────────
  RATE_LIMIT_AI_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().positive().default(300),

  // ── Logging ──────────────────────────────────────────
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // ── AI availability ──────────────────────────────────
  AI_DISABLED: booleanString(false),

  // ── Audit ────────────────────────────────────────────
  STRICT_AUDIT: booleanString(false),

  // ── WhatsApp outbound send rate limits ───────────────
  WA_SEND_PER_CHANNEL_PER_MIN: z.coerce.number().int().positive().default(20),
  WA_SEND_PER_USER_PER_MIN: z.coerce.number().int().positive().default(30),

  // ── WhatsApp reconnect circuit ───────────────────────
  WA_RECONNECT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),

  // ── PRE-PILOT SAFE MODE ──────────────────────────────
  // Master kill-switch for ANY real WhatsApp outbound.
  //   false (default) → every send is rejected before the socket is touched.
  //   true            → sends are still gated by per-conversation mapping
  //                     and the runtime "outbound.enabled" setting.
  // The default is false on purpose: an operator who hasn't explicitly
  // enabled outbound MUST not be able to send a real proposal.
  ENABLE_OUTBOUND_MESSAGES: booleanString(false),

  // When true, ingestion accepts a message ONLY if the conversation it
  // belongs to has an explicit assignedRole='profiles_source'. Random
  // family/private/random groups on a profiles_source channel are NOT
  // ingested. Default true (safer); flip to false only after every
  // active conversation has been explicitly mapped.
  REQUIRE_EXPLICIT_SOURCE_MAPPING: booleanString(true),

  // ── WhatsApp session encryption (offline backup only) ──
  WA_SESSION_ENCRYPTION_KEY: z.string().optional(),
}).superRefine((cfg, ctx) => {
  // Production invariants
  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'JWT_SECRET must be at least 32 characters in production',
        path: ['JWT_SECRET'],
      });
    }
    if (cfg.AUTH_DEV_HEADER_ALLOWED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AUTH_DEV_HEADER_ALLOWED must be false in production',
        path: ['AUTH_DEV_HEADER_ALLOWED'],
      });
    }
    if (cfg.CORS_ORIGINS.includes('localhost')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CORS_ORIGINS must not include localhost in production',
        path: ['CORS_ORIGINS'],
      });
    }
    if (!cfg.AI_DISABLED && !cfg.GROQ_API_KEY && !cfg.OPENAI_API_KEY && !cfg.OPENAI && !cfg.FALLBACK_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one AI key (GROQ_API_KEY / OPENAI_API_KEY / FALLBACK_API_KEY) must be set in production (or set AI_DISABLED=true)',
        path: ['GROQ_API_KEY', 'OPENAI_API_KEY'],
      });
    }
    if (cfg.WA_SESSION_ENCRYPTION_KEY && !/^[0-9a-fA-F]{64}$/.test(cfg.WA_SESSION_ENCRYPTION_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'WA_SESSION_ENCRYPTION_KEY must be 64 hex chars (32 bytes) in production',
        path: ['WA_SESSION_ENCRYPTION_KEY'],
      });
    }
  }
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('❌ Invalid environment variables:');
    for (const issue of parsed.error.issues) {
      console.error(`   ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();
export type Env = z.infer<typeof envSchema>;

/** Parsed list of CORS origins */
export const corsOrigins: string[] = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);

// Dev-only soft warning for missing AI keys
if (env.NODE_ENV !== 'production' && !env.AI_DISABLED && !env.GROQ_API_KEY && !env.OPENAI_API_KEY && !env.OPENAI && !env.FALLBACK_API_KEY) {
  console.warn('[env] No AI key set (GROQ_API_KEY / OPENAI_API_KEY / FALLBACK_API_KEY); AI calls will fail. Set AI_DISABLED=true to silence.');
}
