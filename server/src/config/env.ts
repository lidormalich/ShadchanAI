import { z } from 'zod';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // ── Security / auth ──────────────────────────────────
  /** Must be at least 32 chars in production. Used to sign JWTs. */
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),

  /** Comma-separated list of allowed CORS origins */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /** Dev-only auth fallback: accept X-Dev-User header. Never set true in production. */
  AUTH_DEV_HEADER_ALLOWED: z.coerce.boolean().default(false),

  /** Request body size limit */
  BODY_LIMIT: z.string().default('2mb'),

  // ── Database ─────────────────────────────────────────
  MONGODB_URI: z.string().min(1),

  // ── Groq AI (primary) ────────────────────────────────
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),

  // ── Fallback AI provider ─────────────────────────────
  FALLBACK_PROVIDER: z.enum(['openai', 'anthropic']).default('openai'),
  FALLBACK_API_KEY: z.string().optional(),
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
  WA_AUTO_START_SESSIONS: z.coerce.boolean().default(true),

  // ── Embeddings ───────────────────────────────────────
  EMBEDDINGS_PROVIDER: z.string().optional(),
  EMBEDDINGS_API_KEY: z.string().optional(),
  EMBEDDINGS_MODEL: z.string().optional(),

  // ── Rate limiting ────────────────────────────────────
  RATE_LIMIT_AI_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().positive().default(300),

  // ── Logging ──────────────────────────────────────────
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // ── AI availability ──────────────────────────────────
  AI_DISABLED: z.coerce.boolean().default(false),

  // ── Audit ────────────────────────────────────────────
  STRICT_AUDIT: z.coerce.boolean().default(false),

  // ── WhatsApp outbound send rate limits ───────────────
  WA_SEND_PER_CHANNEL_PER_MIN: z.coerce.number().int().positive().default(20),
  WA_SEND_PER_USER_PER_MIN: z.coerce.number().int().positive().default(30),

  // ── WhatsApp reconnect circuit ───────────────────────
  WA_RECONNECT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),

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
    if (!cfg.AI_DISABLED && !cfg.GROQ_API_KEY && !cfg.FALLBACK_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of GROQ_API_KEY or FALLBACK_API_KEY must be set in production (or set AI_DISABLED=true)',
        path: ['GROQ_API_KEY', 'FALLBACK_API_KEY'],
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
if (env.NODE_ENV !== 'production' && !env.AI_DISABLED && !env.GROQ_API_KEY && !env.FALLBACK_API_KEY) {
  console.warn('[env] No GROQ_API_KEY or FALLBACK_API_KEY set; AI calls will fail. Set AI_DISABLED=true to silence.');
}
