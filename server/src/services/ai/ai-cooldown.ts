// ═══════════════════════════════════════════════════════════
// ShadchanAI — Global AI Rate-Limit Cooldown Bus
//
// A process-global "cooldown" signal shared between the AI providers
// (producers of the 429 signal) and the extraction queue (the consumer
// that decides how fast to feed the AI).
//
// Why this exists:
//   The OpenAI-compatible client already retries a single 429 with
//   backoff. But our rate limits are TPM (tokens per MINUTE) at the
//   ORG level — when a backfill fires several concurrent extractions,
//   we saturate the whole minute's budget with our OWN traffic. A
//   per-request retry can't help: the pressure is the other in-flight
//   requests, not this one. The only real fix is to slow the SOURCE.
//
//   So: whenever any provider observes a 429, it records a cooldown
//   window here. The extraction queue consults `cooldownRemainingMs()`
//   before starting the next item and holds until it clears — turning
//   a self-inflicted burst into a smooth, self-pacing drip that rides
//   just under the per-minute ceiling instead of slamming into it.
// ═══════════════════════════════════════════════════════════

import { createLogger } from '../../utils/logger.js';

const log = createLogger('ai.cooldown');

// A 429 often carries a tiny Retry-After (e.g. "317ms") — misleading when
// the WHOLE org TPM is saturated by our own concurrency, because the real
// relief only arrives when the per-minute window rolls. So we hold at least
// MIN and never longer than MAX, regardless of what the header claims.
const MIN_COOLDOWN_MS = 4_000;
const MAX_COOLDOWN_MS = 30_000;

let cooldownUntil = 0;
// Back-to-back 429s (no successful call between) mean sustained saturation —
// escalate the window each time, capped at MAX. A clean call decays it.
let consecutive = 0;

/**
 * Record that a provider just hit a rate limit. Extends the global cooldown
 * window. `retryAfterMs` (from the Retry-After header, when present) is used
 * as a floor but never trusted below MIN.
 */
export function noteRateLimit(retryAfterMs?: number | null): void {
  consecutive += 1;
  const floor = Math.max(retryAfterMs ?? 0, MIN_COOLDOWN_MS);
  const windowMs = Math.min(floor * consecutive, MAX_COOLDOWN_MS);
  const until = Date.now() + windowMs;
  if (until > cooldownUntil) {
    cooldownUntil = until;
    log.warn(
      { cooldownMs: windowMs, consecutive, retryAfterMs: retryAfterMs ?? null },
      'ai_cooldown_engaged',
    );
  }
}

/**
 * Record a clean AI call. Decays the escalation so a single stray 429 doesn't
 * keep the pipeline throttled once pressure has eased.
 */
export function noteSuccess(): void {
  if (consecutive > 0) consecutive = 0;
}

/** Milliseconds until the current cooldown clears (0 when not cooling down). */
export function cooldownRemainingMs(): number {
  return Math.max(0, cooldownUntil - Date.now());
}

/**
 * Await until the cooldown clears. Re-checks after each sleep because a fresh
 * 429 (from other in-flight work) may have extended the window while we waited.
 */
export async function waitForCooldown(): Promise<void> {
  let remaining = cooldownRemainingMs();
  while (remaining > 0) {
    await new Promise((r) => setTimeout(r, remaining));
    remaining = cooldownRemainingMs();
  }
}
