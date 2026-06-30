// ═══════════════════════════════════════════════════════════
// Per-channel ownership lock for Baileys sessions.
//
// Goal: prevent two processes (or a stale crashed process)
// from running the same WhatsApp session at once. Locks are
// persisted on the Channel document so they survive restart
// and are visible cross-process.
//
// Lock model:
//   - Storage: Channel.{ownerInstanceId, ownerHeartbeatAt}
//   - Owner   : the value of INSTANCE_ID (this process)
//   - Liveness: a 20s heartbeat (driven by BaileysClient when
//               the socket is 'connected'). A lock with no
//               heartbeat for STALE_MS is reclaimable.
//
// INSTANCE_ID resolution order (most stable first):
//   1. env.WA_INSTANCE_ID    — explicit, stable across restarts
//   2. process.env.HOSTNAME  — usually stable in containers
//   3. crypto.randomUUID()   — fallback; loses identity on restart
// Stable IDs let a restarted process reclaim its OWN lock
// immediately instead of waiting for the stale window.
//
// EVERY lock state transition emits a structured log line so
// operators can trace lock conflicts in production. No silent
// failures.
// ═══════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import { Channel } from '../../models/index.js';
import { createLogger } from '../../utils/logger.js';

function resolveInstanceId(): string {
  const explicit = process.env['WA_INSTANCE_ID'];
  if (explicit && explicit.trim()) return explicit.trim();
  const host = process.env['HOSTNAME'];
  if (host && host.trim()) return `host:${host.trim()}`;
  return `gen:${crypto.randomUUID()}`;
}

export const INSTANCE_ID = resolveInstanceId();

/** A heartbeat older than this means the owning process is
 *  almost certainly dead and another process may reclaim. */
export const STALE_MS = 60_000;

/** How frequently a connected client should refresh the
 *  heartbeat. Must be < STALE_MS / 2. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

export interface LockInfo {
  channelId: string;
  ownerInstanceId: string | null;
  ownerHeartbeatAt: Date | null;
  /** Milliseconds since the last heartbeat, or null when no lock. */
  ageMs: number | null;
  /** True when there's an owner whose heartbeat is older than STALE_MS. */
  isStale: boolean;
  /** True when this process is the recorded owner. */
  isOurs: boolean;
}

const log = createLogger('instance.lock').child({ instanceId: INSTANCE_ID });

function logLock(payload: Record<string, unknown>): void {
  const { event, ...rest } = payload as { event?: string };
  log.info(rest, typeof event === 'string' ? event : 'lock');
}

function logLockWarn(payload: Record<string, unknown>): void {
  const { event, ...rest } = payload as { event?: string };
  log.warn(rest, typeof event === 'string' ? event : 'lock');
}

/**
 * Try to acquire the lock for this channel.
 * Returns { acquired, reason } so the caller can log/report
 * meaningfully. The DB filter atomically accepts:
 *   - no current owner
 *   - this process is already the owner (re-acquire is OK)
 *   - the current owner's heartbeat has gone stale
 *
 * Always touches ownerHeartbeatAt so a fresh acquire starts
 * with a clean clock.
 */
export async function acquireChannelLock(channelId: string): Promise<{
  acquired: boolean;
  reason: 'fresh' | 'reacquired_own' | 'reclaimed_stale' | 'held_by_other';
  previousOwner?: string | null;
  previousHeartbeatAt?: Date | null;
}> {
  // Inspect first so we can attribute the result accurately.
  const before = await inspectChannelLock(channelId);

  const staleCutoff = new Date(Date.now() - STALE_MS);
  const res = await Channel.updateOne(
    {
      channelId,
      $or: [
        { ownerInstanceId: null },
        { ownerInstanceId: INSTANCE_ID },
        { ownerHeartbeatAt: { $lt: staleCutoff } },
        { ownerHeartbeatAt: { $exists: false } },
      ],
    },
    { $set: { ownerInstanceId: INSTANCE_ID, ownerHeartbeatAt: new Date() } },
  ).exec();

  if (res.matchedCount !== 1) {
    logLockWarn({
      event: 'lock_acquire_skipped_held',
      channelId,
      heldBy: before.ownerInstanceId,
      heartbeatAgeMs: before.ageMs,
    });
    return {
      acquired: false,
      reason: 'held_by_other',
      previousOwner: before.ownerInstanceId,
      previousHeartbeatAt: before.ownerHeartbeatAt,
    };
  }

  let reason: 'fresh' | 'reacquired_own' | 'reclaimed_stale';
  if (!before.ownerInstanceId) {
    reason = 'fresh';
  } else if (before.ownerInstanceId === INSTANCE_ID) {
    reason = 'reacquired_own';
  } else {
    reason = 'reclaimed_stale';
    logLockWarn({
      event: 'lock_reclaimed_stale',
      channelId,
      previousOwner: before.ownerInstanceId,
      heartbeatAgeMs: before.ageMs,
    });
  }
  logLock({ event: 'lock_acquired', channelId, reason });
  return {
    acquired: true,
    reason,
    previousOwner: before.ownerInstanceId,
    previousHeartbeatAt: before.ownerHeartbeatAt,
  };
}

/** Refresh ownerHeartbeatAt — only succeeds while we still own
 *  the lock. Returns true when the heartbeat landed; false when
 *  ownership has been lost (caller should stop the client). */
export async function heartbeatChannelLock(channelId: string): Promise<boolean> {
  const res = await Channel.updateOne(
    { channelId, ownerInstanceId: INSTANCE_ID },
    { $set: { ownerHeartbeatAt: new Date() } },
  ).exec();
  if (res.matchedCount !== 1) {
    logLockWarn({ event: 'heartbeat_lost_ownership', channelId });
    return false;
  }
  return true;
}

/** Release the lock — only if we own it. Idempotent; safe to
 *  call from try/finally even when ownership was never gained
 *  (no-op in that case). */
export async function releaseChannelLock(channelId: string): Promise<boolean> {
  const res = await Channel.updateOne(
    { channelId, ownerInstanceId: INSTANCE_ID },
    { $set: { ownerInstanceId: null, ownerHeartbeatAt: null } },
  ).exec();
  if (res.matchedCount === 1) {
    logLock({ event: 'lock_released', channelId });
    return true;
  }
  return false;
}

/** Read the current lock state without mutating it. Intended
 *  for the admin "sessions" view and for diagnostic logging. */
export async function inspectChannelLock(channelId: string): Promise<LockInfo> {
  const doc = await Channel.findOne({ channelId })
    .select({ channelId: 1, ownerInstanceId: 1, ownerHeartbeatAt: 1 })
    .lean()
    .exec();
  if (!doc) {
    return {
      channelId,
      ownerInstanceId: null,
      ownerHeartbeatAt: null,
      ageMs: null,
      isStale: false,
      isOurs: false,
    };
  }
  const ownerInstanceId = (doc as { ownerInstanceId?: string | null }).ownerInstanceId ?? null;
  const ownerHeartbeatAt = (doc as { ownerHeartbeatAt?: Date }).ownerHeartbeatAt ?? null;
  const ageMs = ownerHeartbeatAt ? Date.now() - ownerHeartbeatAt.getTime() : null;
  const isStale = !!ownerInstanceId && ageMs !== null && ageMs > STALE_MS;
  return {
    channelId,
    ownerInstanceId,
    ownerHeartbeatAt,
    ageMs,
    isStale,
    isOurs: ownerInstanceId === INSTANCE_ID,
  };
}

/** Admin/diagnostic: read locks for many channels at once. */
export async function inspectChannelLocks(channelIds: string[]): Promise<Map<string, LockInfo>> {
  if (channelIds.length === 0) return new Map();
  const docs = await Channel.find({ channelId: { $in: channelIds } })
    .select({ channelId: 1, ownerInstanceId: 1, ownerHeartbeatAt: 1 })
    .lean()
    .exec();
  const out = new Map<string, LockInfo>();
  for (const d of docs as Array<{ channelId: string; ownerInstanceId?: string | null; ownerHeartbeatAt?: Date }>) {
    const ageMs = d.ownerHeartbeatAt ? Date.now() - d.ownerHeartbeatAt.getTime() : null;
    const ownerInstanceId = d.ownerInstanceId ?? null;
    out.set(d.channelId, {
      channelId: d.channelId,
      ownerInstanceId,
      ownerHeartbeatAt: d.ownerHeartbeatAt ?? null,
      ageMs,
      isStale: !!ownerInstanceId && ageMs !== null && ageMs > STALE_MS,
      isOurs: ownerInstanceId === INSTANCE_ID,
    });
  }
  return out;
}

/**
 * Admin override: release a lock regardless of who owns it.
 * Use ONLY when an operator has confirmed the holding process
 * is dead but the heartbeat hasn't aged out yet (e.g., right
 * after a crash, when the lock would otherwise block a restart
 * for up to STALE_MS).
 *
 * Always logs a warning with the previous owner and the reason.
 */
export async function forceReleaseChannelLock(
  channelId: string,
  reason: string,
  performedBy?: string,
): Promise<{ released: boolean; previousOwner: string | null; previousHeartbeatAt: Date | null; ageMs: number | null }> {
  const before = await inspectChannelLock(channelId);
  if (!before.ownerInstanceId) {
    return {
      released: false,
      previousOwner: null,
      previousHeartbeatAt: null,
      ageMs: null,
    };
  }
  await Channel.updateOne(
    { channelId },
    { $set: { ownerInstanceId: null, ownerHeartbeatAt: null } },
  ).exec();
  logLockWarn({
    event: 'lock_force_released',
    channelId,
    previousOwner: before.ownerInstanceId,
    previousHeartbeatAgeMs: before.ageMs,
    wasStale: before.isStale,
    reason,
    performedBy,
  });
  return {
    released: true,
    previousOwner: before.ownerInstanceId,
    previousHeartbeatAt: before.ownerHeartbeatAt,
    ageMs: before.ageMs,
  };
}

/**
 * Release every lock currently owned by THIS process. Called
 * during graceful shutdown so the next start of the same
 * channel — even on a different instance id — is immediate.
 */
export async function releaseAllChannelLocks(reason: string): Promise<{ released: number }> {
  const res = await Channel.updateMany(
    { ownerInstanceId: INSTANCE_ID },
    { $set: { ownerInstanceId: null, ownerHeartbeatAt: null } },
  ).exec();
  const count = res.modifiedCount ?? 0;
  logLock({ event: 'all_locks_released', reason, count });
  return { released: count };
}

/**
 * Opportunistic recovery: clear any lock whose heartbeat is
 * already aged out. Safe to call at boot before auto-start so
 * the operator doesn't see lock_skipped warnings for what is
 * obviously a dead lock from a previous run.
 */
export async function recoverStaleChannelLocks(): Promise<{ recovered: number }> {
  const staleCutoff = new Date(Date.now() - STALE_MS);
  const res = await Channel.updateMany(
    {
      ownerInstanceId: { $ne: null },
      $or: [
        { ownerHeartbeatAt: { $lt: staleCutoff } },
        { ownerHeartbeatAt: { $exists: false } },
      ],
    },
    { $set: { ownerInstanceId: null, ownerHeartbeatAt: null } },
  ).exec();
  const count = res.modifiedCount ?? 0;
  if (count > 0) {
    logLockWarn({ event: 'stale_locks_recovered', count });
  }
  return { recovered: count };
}
