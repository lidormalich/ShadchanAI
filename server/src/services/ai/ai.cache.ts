// ═══════════════════════════════════════════════════════════
// ShadchanAI — AI Cache
//
// In-memory TTL-based cache for stable AI outputs. Keyed by
// SHA-256 hash of (requestType + normalized input).
//
// Cached request types:
//   - explainMatch (scoped by pair IDs + engine scores)
//   - summarizeCandidate (scoped by candidate id + updatedAt)
//   - classifyMessage (scoped by message hash)
//   - suggestNextStep (scoped by suggestion state)
//   - embedText (scoped by text hash)
//
// NOT cached:
//   - generateMessage (user-specific drafts)
//   - askAI (dynamic queries, live DB state)
// ═══════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import type { CacheEntry } from './ai.types.js';
import { AI } from '../../config/constants.js';

const cacheStore = new Map<string, CacheEntry<unknown>>();

/** Max entries before oldest are evicted (rough LRU) */
const MAX_ENTRIES = 1000;

/**
 * Cache-key version. Bump this whenever a prompt change alters the EXPECTED
 * output (e.g. enforcing Hebrew) so previously cached results are bypassed
 * instead of being served stale. v2 = Hebrew-only natural-language outputs.
 */
const CACHE_VERSION = 'v2';

/**
 * Produce a stable SHA-256 hash key for a given request type + input.
 * Input is JSON-stringified with sorted keys for determinism.
 */
export function hashKey(requestType: string, input: unknown): string {
  const normalized = JSON.stringify(input, Object.keys(input ?? {}).sort());
  return crypto.createHash('sha256')
    .update(`${CACHE_VERSION}::${requestType}::${normalized}`)
    .digest('hex');
}

/** Get a cached entry if not expired. Returns null on miss or expiry. */
export function cacheGet<T>(key: string): CacheEntry<T> | null {
  const entry = cacheStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cacheStore.delete(key);
    return null;
  }
  // LRU touch: re-insert to move to end
  cacheStore.delete(key);
  cacheStore.set(key, entry);
  return entry as CacheEntry<T>;
}

/** Store an entry with the default AI cache TTL. */
export function cacheSet<T>(
  key: string,
  data: T,
  metadata: CacheEntry['metadata'],
  ttlMs: number = AI.CACHE_TTL_MS,
): void {
  // Rough LRU: evict oldest if at capacity
  if (cacheStore.size >= MAX_ENTRIES) {
    const oldestKey = cacheStore.keys().next().value;
    if (oldestKey !== undefined) cacheStore.delete(oldestKey);
  }

  const entry: CacheEntry<T> = {
    data,
    metadata,
    expiresAt: Date.now() + ttlMs,
  };
  cacheStore.set(key, entry as CacheEntry<unknown>);
}

/** Invalidate a specific key. */
export function cacheInvalidate(key: string): boolean {
  return cacheStore.delete(key);
}

/** Clear the entire cache (test utility). */
export function cacheClear(): void {
  cacheStore.clear();
}

/** Current cache size (monitoring/metrics). */
export function cacheSize(): number {
  return cacheStore.size;
}
