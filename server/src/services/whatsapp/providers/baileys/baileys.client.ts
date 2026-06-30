// ═══════════════════════════════════════════════════════════
// ShadchanAI — Baileys Client
//
// One client instance == one Baileys socket == one WhatsApp
// channel. Manages:
//   - connect / disconnect / reconnect with exponential backoff
//   - QR code exposure for admin pairing
//   - channel DB status transitions
//   - session purge on explicit logout
//
// The client NEVER calls handlers directly — it wires events via
// baileys.events.ts which funnels into the existing handler layer.
//
// Outbound send is INTENTIONALLY not enabled here. `sendText()`
// exists as a clearly gated stub so the caller path is visible but
// the actual send is a deliberate future step.
// ═══════════════════════════════════════════════════════════

import makeWASocket, {
  type WASocket,
  type WAMessageKey,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';
import { Channel, Message, type IChannel } from '../../../../models/index.js';
import { ChannelStatus, WebhookStatus } from '@shadchanai/shared';
import { BAILEYS } from '../../whatsapp.constants.js';
import { logWhatsApp } from '../../whatsapp.logger.js';
import { loadAuth, purgeSession } from './baileys.session.store.js';
import { wireEvents, classifyDisconnect } from './baileys.events.js';
import type {
  BaileysSessionState,
  BaileysChannelStatus,
  ChannelStatusPatch,
  ChannelStatusPersister,
} from '../../whatsapp.types.js';
import { env } from '../../../../config/env.js';
import {
  acquireChannelLock,
  heartbeatChannelLock,
  releaseChannelLock,
  inspectChannelLocks,
  recoverStaleChannelLocks,
  HEARTBEAT_INTERVAL_MS,
  INSTANCE_ID,
  type LockInfo,
} from '../../instance.lock.js';
import { createLogger } from '../../../../utils/logger.js';

const log = createLogger('baileys.client');

type PinoLike = Parameters<typeof makeWASocket>[0]['logger'];

// ── Minimal pino-shaped silent logger to satisfy Baileys' logger contract ──
// Baileys uses pino. We don't want to pull it in just for typing — provide
// an inline silent implementation. This keeps the Baileys output OUT of
// our structured log stream (we emit our own structured events instead).
const silentLogger = (() => {
  const noop = () => {};
  const instance = {
    level: 'silent',
    fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop,
    child: () => instance,
  };
  return instance as unknown as PinoLike;
})();

// ── Client ───────────────────────────────────────────────

export class BaileysClient {
  private sock: WASocket | null = null;
  private reconnectAttempt = 0;
  /** Cumulative attempts since the last successful open — drives circuit breaker. */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentQR: string | null = null;
  private state: BaileysSessionState = 'idle';
  private lastError: string | undefined;
  private lastConnectedAt: Date | undefined;
  /** Set by explicit stop() / logout() to block auto-reconnect */
  private shouldRun = false;

  constructor(private channel: IChannel) {}

  get channelId(): string { return this.channel.channelId; }
  get status(): BaileysChannelStatus {
    return {
      channelId: this.channel.channelId,
      state: this.state,
      qr: this.state === 'pending_pairing' ? this.currentQR ?? undefined : undefined,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
    };
  }

  /** Start (or restart) the socket. Idempotent — safe to call multiple times. */
  async start(): Promise<void> {
    this.shouldRun = true;
    await this.openSocket();
  }

  /** Gracefully close the socket without wiping credentials.
   *  Channel remains recoverable via reconnect/start. */
  async stop(): Promise<void> {
    this.shouldRun = false;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    const s = this.sock;
    this.sock = null;
    this.setState('disconnected');
    try { s?.end(undefined); } catch { /* ignore */ }
    try { await releaseChannelLock(this.channel.channelId); } catch { /* best-effort */ }
  }

  /** Reset the reconnect circuit breaker. Called by operator-initiated reconnect. */
  resetCircuit(): void {
    this.reconnectAttempts = 0;
    this.shouldRun = true;
  }

  /** Explicit logout: tear down socket AND purge on-disk credentials.
   *  The channel record remains (with status suspended) so audit
   *  continuity is preserved; the session must be re-paired. */
  async logout(): Promise<void> {
    this.shouldRun = false;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    try { await this.sock?.logout(); } catch { /* best-effort */ }
    this.sock = null;
    try { await releaseChannelLock(this.channel.channelId); } catch { /* best-effort */ }
    await purgeSession(this.channel.channelId);
    this.setState('logged_out');
    await updateChannelStatus(this.channel.channelId, {
      status: ChannelStatus.SUSPENDED,
      connectionHealth: 'down',
      webhookStatus: WebhookStatus.PENDING,
    });
    logWhatsApp({
      event: 'channel_disconnected',
      channelId: this.channel.channelId,
      channelRole: this.channel.role,
      reason: 'logged_out',
    });
  }

  /**
   * Send a plain-text outbound message.
   *
   * NOTE: This is the low-level socket call. Callers (match.service /
   * conversation.service) are RESPONSIBLE for all policy gates:
   *   - human-approved user id
   *   - channel.role === 'match_sending'
   *   - send-preview canSend=true (match proposals)
   *   - conversation not closed
   *   - pre-flight AuditLog write BEFORE calling this
   *
   * This method ONLY enforces the minimum socket-level invariant:
   *   - client must be in 'connected' state
   *
   * Returns the WhatsApp-assigned message id, which the caller must
   * persist as Message.externalMessageId for status-update correlation.
   */
  async sendText(jid: string, text: string): Promise<string> {
    if (this.state !== 'connected' || !this.sock) {
      throw new Error(`Baileys client for ${this.channel.channelId} is not connected (state=${this.state})`);
    }
    if (!text || !text.trim()) {
      throw new Error('Cannot send empty message body');
    }
    const result = await this.sock.sendMessage(jid, { text });
    const messageId = result?.key?.id;
    if (!messageId) {
      throw new Error('Baileys returned no message id for the send');
    }
    return messageId;
  }

  /**
   * Request the raw chat list from Baileys. Only groups are
   * available without a long-running chat-store; private chats
   * become visible via conversations we've already received.
   * The channel-service merges both sources.
   */
  async listGroupChats(): Promise<Array<{ jid: string; name: string; participantCount?: number }>> {
    if (this.state !== 'connected' || !this.sock) return [];
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      const out: Array<{ jid: string; name: string; participantCount?: number }> = [];
      for (const [jid, meta] of Object.entries(groups)) {
        out.push({
          jid,
          name: (meta as { subject?: string }).subject ?? jid,
          participantCount: (meta as { participants?: unknown[] }).participants?.length,
        });
      }
      return out;
    } catch (err) {
      logWhatsApp({
        event: 'error',
        channelId: this.channel.channelId,
        channelRole: this.channel.role,
        errorMessage: `groupFetchAllParticipating: ${(err as Error).message}`,
      });
      return [];
    }
  }

  // ── Internals ─────────────────────────────────────────

  /**
   * Message store for Baileys' getMessage hook. Best-effort:
   *   - inbound: return the stored raw proto (rawPayload.message)
   *   - outbound: reconstruct a text message from the persisted body
   *     (our outbound is text-only proposals)
   * Returns undefined when we can't recover it (large/media payloads),
   * which is the same as not providing the hook for that one message.
   */
  private async getStoredMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    const id = key?.id;
    if (!id) return undefined;
    try {
      const m = await Message.findOne({ externalMessageId: id })
        .select('+rawPayload body')
        .lean()
        .exec();
      if (!m) return undefined;
      const raw = (m as { rawPayload?: { message?: proto.IMessage } }).rawPayload?.message;
      if (raw) return raw;
      const body = (m as { body?: string }).body;
      if (body) return { conversation: body };
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async openSocket(): Promise<void> {
    try {
      const auth = await loadAuth(this.channel.channelId);
      const { version } = await fetchLatestBaileysVersion();

      this.setState('connecting');

      const sock = makeWASocket({
        version,
        auth: {
          creds: auth.state.creds,
          // Cache signal keys in-memory to avoid a disk hit per lookup
          // and reduce signal-store races during bursts of inbound.
          keys: makeCacheableSignalKeyStore(auth.state.keys, silentLogger),
        },
        logger: silentLogger,
        printQRInTerminal: false,
        browser: ['ShadchanAI', 'Chrome', '120.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        // Required for reliable delivery: Baileys calls this to recover a
        // message for retry-receipt resends (outbound) and poll decryption.
        // Without it, an outbound proposal the recipient's device asks to
        // retry is silently never resent, and some inbound messages stay
        // stuck on "waiting for this message".
        getMessage: (key) => this.getStoredMessage(key),
      });

      this.sock = sock;

      // Persist creds on change
      sock.ev.on('creds.update', () => { void auth.saveCreds(); });

      // Wire message / status events + connection lifecycle
      wireEvents(sock, {
        channel: this.channel,
        onConnectionUpdate: (update) => { void this.handleConnectionUpdate(update); },
      });
    } catch (err) {
      this.lastError = (err as Error).message;
      logWhatsApp({
        event: 'error',
        channelId: this.channel.channelId,
        channelRole: this.channel.role,
        errorMessage: `openSocket: ${this.lastError}`,
      });
      this.scheduleReconnect();
    }
  }

  private async handleConnectionUpdate(update: {
    connection?: 'open' | 'connecting' | 'close';
    qr?: string;
    isNewLogin?: boolean;
    lastDisconnect?: { error?: Error; date?: Date };
  }): Promise<void> {
    // QR is emitted before connection opens
    if (update.qr) {
      this.currentQR = update.qr;
      this.setState('pending_pairing');
      logWhatsApp({
        event: 'channel_connected',
        channelId: this.channel.channelId,
        channelRole: this.channel.role,
        qrReady: true,
      });
      return;
    }

    if (update.connection === 'connecting') {
      this.setState('connecting');
      return;
    }

    if (update.connection === 'open') {
      this.currentQR = null;
      this.reconnectAttempt = 0;
      this.reconnectAttempts = 0;
      this.lastError = undefined;
      this.lastConnectedAt = new Date();
      this.setState('connected');
      this.startHeartbeatTimer();

      // On first successful connection, backfill phoneNumber from the JID
      const user = this.sock?.user;
      const jidLocal = user?.id?.split('@')[0]?.split(':')[0];

      await updateChannelStatus(this.channel.channelId, {
        status: ChannelStatus.ACTIVE,
        connectionHealth: 'healthy',
        webhookStatus: WebhookStatus.VERIFIED,
        lastConnectedAt: this.lastConnectedAt,
        ...(jidLocal && !this.channel.phoneNumber ? { phoneNumber: jidLocal } : {}),
      });

      logWhatsApp({
        event: 'channel_connected',
        channelId: this.channel.channelId,
        channelRole: this.channel.role,
        accountDisplayName: this.channel.accountDisplayName,
      });
      return;
    }

    if (update.connection === 'close') {
      this.clearHeartbeatTimer();
      const err = update.lastDisconnect?.error;
      const classification = classifyDisconnect(err);
      this.lastError = classification.message;

      logWhatsApp({
        event: 'channel_disconnected',
        channelId: this.channel.channelId,
        channelRole: this.channel.role,
        reason: `${classification.kind}${classification.statusCode ? ` (${classification.statusCode})` : ''}`,
        errorMessage: classification.message,
      });

      if (classification.kind === 'logged_out') {
        await this.logout();
        return;
      }

      if (classification.kind === 'replaced') {
        await updateChannelStatus(this.channel.channelId, {
          status: ChannelStatus.REPLACED,
          connectionHealth: 'down',
        });
        this.setState('disconnected');
        this.shouldRun = false;
        // Terminal transition: drop the lock so another process
        // (or a follow-up start of the new replacement channel)
        // doesn't have to wait for the stale window.
        try { await releaseChannelLock(this.channel.channelId); } catch { /* best-effort */ }
        return;
      }

      if (classification.kind === 'suspended') {
        await updateChannelStatus(this.channel.channelId, {
          status: ChannelStatus.SUSPENDED,
          connectionHealth: 'down',
        });
        this.setState('disconnected');
        this.shouldRun = false;
        try { await releaseChannelLock(this.channel.channelId); } catch { /* best-effort */ }
        return;
      }

      // Transient: reconnect if we haven't been explicitly stopped
      // and the reason isn't a final DisconnectReason.loggedOut sneaking through
      if (this.shouldRun && (err as Boom | undefined)?.output?.statusCode !== DisconnectReason.loggedOut) {
        this.setState('reconnecting');
        await updateChannelStatus(this.channel.channelId, {
          connectionHealth: 'degraded',
        });
        this.scheduleReconnect();
      } else {
        this.setState('disconnected');
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun) return;
    this.clearReconnectTimer();
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > env.WA_RECONNECT_MAX_ATTEMPTS) {
      this.shouldRun = false;
      this.setState('disconnected');
      void this.openCircuit();
      return;
    }
    const attempt = ++this.reconnectAttempt;
    const backoff = Math.min(
      BAILEYS.RECONNECT_BACKOFF_MS * 2 ** (attempt - 1),
      BAILEYS.RECONNECT_MAX_BACKOFF_MS,
    );
    this.reconnectTimer = setTimeout(() => { void this.openSocket(); }, backoff);
  }

  private async openCircuit(): Promise<void> {
    const attempts = this.reconnectAttempts;
    this.clearHeartbeatTimer();
    try {
      await updateChannelStatus(this.channel.channelId, {
        status: ChannelStatus.SUSPENDED,
        connectionHealth: 'down',
        statusReason: 'reconnect_circuit_open',
        lastDisconnectAt: new Date(),
      });
    } catch { /* best-effort */ }
    // Reconnect circuit is terminal — drop the lock so the next
    // operator-initiated start (which will run resetCircuit() too)
    // doesn't trip channel_skipped_lock_held.
    try { await releaseChannelLock(this.channel.channelId); } catch { /* best-effort */ }
    log.error({ channelId: this.channel.channelId, attempts }, 'baileys_circuit_open');
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeatTimer(): void {
    this.clearHeartbeatTimer();
    const channelId = this.channel.channelId;
    this.heartbeatTimer = setInterval(async () => {
      // If we lost ownership while running (e.g., another instance
      // force-released our lock), shut this client down rather than
      // continuing to claim a session it no longer owns.
      const stillOwned = await heartbeatChannelLock(channelId).catch(() => false);
      if (!stillOwned) {
        this.clearHeartbeatTimer();
        try { await this.stop(); } catch { /* best-effort */ }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private setState(s: BaileysSessionState): void {
    this.state = s;
  }
}

// ── Registry ─────────────────────────────────────────────
// One-client-per-channel, keyed by channelId. The registry
// must live inside a single Node process (Baileys sockets are
// not shareable). Multi-instance deployments need session
// affinity — see deployment notes.

const clients = new Map<string, BaileysClient>();

export async function startChannelClient(channel: IChannel): Promise<BaileysClient> {
  let client = clients.get(channel.channelId);
  if (!client) {
    client = new BaileysClient(channel);
    clients.set(channel.channelId, client);
  }
  await client.start();
  return client;
}

export function getChannelClient(channelId: string): BaileysClient | undefined {
  return clients.get(channelId);
}

export async function stopChannelClient(channelId: string): Promise<void> {
  const client = clients.get(channelId);
  if (!client) return;
  await client.stop();
  clients.delete(channelId);
}

export async function logoutChannelClient(channelId: string): Promise<void> {
  const client = clients.get(channelId);
  if (!client) return;
  await client.logout();
  clients.delete(channelId);
}

// ── Boot-time auto-start ──────────────────────────────────

export type StartChannelOutcome =
  | { channelId: string; result: 'started';  reason: string; durationMs: number }
  | { channelId: string; result: 'already_connected'; durationMs: number }
  | { channelId: string; result: 'skipped_lock_held'; lockHolder: string | null; lockAgeMs: number | null; durationMs: number }
  | { channelId: string; result: 'failed'; errorMessage: string; durationMs: number };

export interface BootStartupReport {
  instanceId: string;
  totalConsidered: number;
  started: number;
  alreadyConnected: number;
  skippedLockHeld: number;
  failed: number;
  durationMs: number;
  outcomes: StartChannelOutcome[];
}

/**
 * Try to start a single channel. Always either acquires the
 * lock and runs the client, or returns a structured outcome
 * describing why it didn't. Lock is released on every failure
 * path so a transient error never leaks ownership.
 */
async function startOneChannel(channel: IChannel): Promise<StartChannelOutcome> {
  const started = Date.now();
  const channelId = channel.channelId;

  // If a client is already registered & connected from an earlier
  // call (or the operator started it via the API), don't re-acquire.
  const existing = clients.get(channelId);
  if (existing && existing.status.state === 'connected') {
    return { channelId, result: 'already_connected', durationMs: Date.now() - started };
  }

  const acquire = await acquireChannelLock(channelId);
  if (!acquire.acquired) {
    return {
      channelId,
      result: 'skipped_lock_held',
      lockHolder: acquire.previousOwner ?? null,
      lockAgeMs: acquire.previousHeartbeatAt
        ? Date.now() - acquire.previousHeartbeatAt.getTime()
        : null,
      durationMs: Date.now() - started,
    };
  }

  // We hold the lock — release it on ANY failure path so the next
  // boot or operator action isn't blocked.
  try {
    await startChannelClient(channel);
    return { channelId, result: 'started', reason: acquire.reason, durationMs: Date.now() - started };
  } catch (err) {
    const errorMessage = (err as Error).message;
    logWhatsApp({
      event: 'error',
      channelId,
      channelRole: channel.role,
      errorMessage: `startOneChannel: ${errorMessage}`,
    });
    try { await releaseChannelLock(channelId); } catch { /* best-effort */ }
    // Drop the in-memory registry entry for this channel so a retry
    // gets a fresh client object.
    const stale = clients.get(channelId);
    if (stale && stale.status.state !== 'connected') {
      try { await stale.stop(); } catch { /* best-effort */ }
      clients.delete(channelId);
    }
    return { channelId, result: 'failed', errorMessage, durationMs: Date.now() - started };
  }
}

/**
 * Boot-time auto-start. Each channel is attempted independently
 * and concurrently — one failure or lock-conflict never blocks
 * the others. Returns a structured report the server entry point
 * uses to emit a single readable startup summary.
 *
 * Skips replaced / disconnected / suspended channels; those need
 * explicit operator action (POST /channels/:id/session/start or
 * /reconnect).
 */
export async function startAllChannels(): Promise<BootStartupReport> {
  const startedAt = Date.now();
  // Opportunistic stale-lock cleanup. Locks from a previous crashed
  // run don't survive across the STALE window anyway, but doing this
  // on boot makes the report below describe REAL conflicts only.
  await recoverStaleChannelLocks().catch(() => ({ recovered: 0 }));

  const channels = await Channel.find({
    status: { $in: [ChannelStatus.ACTIVE, ChannelStatus.RATE_LIMITED] },
  }).exec();

  const outcomes = await Promise.all(channels.map((ch) => startOneChannel(ch)));

  const report: BootStartupReport = {
    instanceId: INSTANCE_ID,
    totalConsidered: channels.length,
    started:           outcomes.filter((o) => o.result === 'started').length,
    alreadyConnected:  outcomes.filter((o) => o.result === 'already_connected').length,
    skippedLockHeld:   outcomes.filter((o) => o.result === 'skipped_lock_held').length,
    failed:            outcomes.filter((o) => o.result === 'failed').length,
    durationMs: Date.now() - startedAt,
    outcomes,
  };

  log.info({ ...report }, 'baileys_startup_report');
  return report;
}

export interface StopAllReport {
  instanceId: string;
  total: number;
  stopped: number;
  failed: number;
  durationMs: number;
  failures: Array<{ channelId: string; errorMessage: string }>;
}

export async function stopAllChannels(): Promise<StopAllReport> {
  const startedAt = Date.now();
  const ids = Array.from(clients.keys());
  const settled = await Promise.allSettled(ids.map((id) => stopChannelClient(id)));
  const failures: Array<{ channelId: string; errorMessage: string }> = [];
  let stopped = 0;
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') stopped += 1;
    else failures.push({ channelId: ids[i]!, errorMessage: (r.reason as Error)?.message ?? 'unknown' });
  });
  const report: StopAllReport = {
    instanceId: INSTANCE_ID,
    total: ids.length,
    stopped,
    failed: failures.length,
    durationMs: Date.now() - startedAt,
    failures,
  };
  log.info({ ...report }, 'baileys_shutdown_report');
  return report;
}

// ── Admin/diagnostic: visibility into the live registry ──

export interface RegistrySnapshotEntry {
  channelId: string;
  hasLiveClient: true;
  state: BaileysSessionState;
  lastError?: string;
  lastConnectedAt?: Date;
}

export function snapshotClientRegistry(): RegistrySnapshotEntry[] {
  const out: RegistrySnapshotEntry[] = [];
  for (const [channelId, client] of clients.entries()) {
    const s = client.status;
    out.push({
      channelId,
      hasLiveClient: true,
      state: s.state,
      lastError: s.lastError,
      lastConnectedAt: s.lastConnectedAt,
    });
  }
  return out;
}

/** Fast existence check without touching client state. */
export function hasLiveClient(channelId: string): boolean {
  return clients.has(channelId);
}

/** Combine the registry snapshot with persisted lock info — used
 *  by the admin sessions overview. */
export async function describeAllSessions(): Promise<Array<{
  channelId: string;
  hasLiveClient: boolean;
  state: BaileysSessionState | null;
  lastError?: string;
  lastConnectedAt?: Date;
  lock: LockInfo;
}>> {
  const allChannels = await Channel.find({}).select({ channelId: 1 }).lean().exec();
  const channelIds = (allChannels as Array<{ channelId: string }>).map((c) => c.channelId);
  const lockMap = await inspectChannelLocks(channelIds);
  return channelIds.map((channelId) => {
    const client = clients.get(channelId);
    const s = client?.status;
    return {
      channelId,
      hasLiveClient: !!client,
      state: s?.state ?? null,
      lastError: s?.lastError,
      lastConnectedAt: s?.lastConnectedAt,
      lock: lockMap.get(channelId) ?? {
        channelId,
        ownerInstanceId: null,
        ownerHeartbeatAt: null,
        ageMs: null,
        isStale: false,
        isOurs: false,
      },
    };
  });
}

// ── Channel status persistence seam ───────────────────────
//
// The transport detects connection/status transitions but does NOT
// own domain persistence. channel.manager registers a persister via
// `setChannelStatusPersister` at import time; the client emits status
// patches through it. Until one is registered we keep a no-op so the
// socket layer is functional in isolation (e.g. focused unit tests).

let channelStatusPersister: ChannelStatusPersister = async () => { /* no-op until registered */ };

/** Registered by channel.manager to keep Channel-model writes in the
 *  domain layer. Public so the manager can wire it without a circular
 *  value import back into this module. */
export function setChannelStatusPersister(persister: ChannelStatusPersister): void {
  channelStatusPersister = persister;
}

/** Emit a channel status change to the registered domain persister. */
async function updateChannelStatus(channelId: string, patch: ChannelStatusPatch): Promise<void> {
  await channelStatusPersister(channelId, patch);
}

// ── Type alias used by error classifier ──────────────────

type Boom = import('@hapi/boom').Boom;
