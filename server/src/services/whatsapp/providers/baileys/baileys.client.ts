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
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Channel, type IChannel } from '../../../../models/index.js';
import { ChannelStatus, WebhookStatus } from '@shadchanai/shared';
import { BAILEYS } from '../../whatsapp.constants.js';
import { logWhatsApp } from '../../whatsapp.logger.js';
import { loadAuth, purgeSession } from './baileys.session.store.js';
import { wireEvents, classifyDisconnect } from './baileys.events.js';
import type { BaileysSessionState, BaileysChannelStatus } from '../../whatsapp.types.js';
import { env } from '../../../../config/env.js';
import {
  acquireChannelLock,
  heartbeatChannelLock,
  releaseChannelLock,
  INSTANCE_ID,
} from '../../instance.lock.js';

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

  private async openSocket(): Promise<void> {
    try {
      const auth = await loadAuth(this.channel.channelId);
      const { version } = await fetchLatestBaileysVersion();

      this.setState('connecting');

      const sock = makeWASocket({
        version,
        auth: auth.state,
        logger: silentLogger,
        printQRInTerminal: false,
        browser: ['ShadchanAI', 'Chrome', '120.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
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
        return;
      }

      if (classification.kind === 'suspended') {
        await updateChannelStatus(this.channel.channelId, {
          status: ChannelStatus.SUSPENDED,
          connectionHealth: 'down',
        });
        this.setState('disconnected');
        this.shouldRun = false;
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
    try {
      await Channel.updateOne({ channelId: this.channel.channelId }, {
        $set: {
          status: ChannelStatus.SUSPENDED,
          connectionHealth: 'down',
          statusReason: 'reconnect_circuit_open',
          lastDisconnectAt: new Date(),
        },
      }).exec();
    } catch { /* best-effort */ }
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ event: 'baileys_circuit_open', channelId: this.channel.channelId, attempts }));
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
    this.heartbeatTimer = setInterval(() => { void heartbeatChannelLock(channelId); }, 20_000);
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

/** Boot-time: start Baileys for every active/degraded channel.
 *  Skips replaced / disconnected / suspended channels — those must be
 *  explicitly reconnected by an admin. */
export async function startAllChannels(): Promise<void> {
  const channels = await Channel.find({
    status: { $in: [ChannelStatus.ACTIVE, ChannelStatus.RATE_LIMITED] },
  }).exec();
  for (const ch of channels) {
    try {
      const locked = await acquireChannelLock(ch.channelId);
      if (!locked) {
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({ event: 'channel_skipped_lock_held', channelId: ch.channelId, instanceId: INSTANCE_ID }));
        continue;
      }
      await startChannelClient(ch);
    } catch (err) {
      logWhatsApp({
        event: 'error',
        channelId: ch.channelId,
        channelRole: ch.role,
        errorMessage: `startAll: ${(err as Error).message}`,
      });
    }
  }
}

export async function stopAllChannels(): Promise<void> {
  const ids = Array.from(clients.keys());
  await Promise.allSettled(ids.map((id) => stopChannelClient(id)));
}

// ── Helper: persist channel status changes ────────────────

async function updateChannelStatus(
  channelId: string,
  patch: Partial<Pick<IChannel, 'status' | 'connectionHealth' | 'webhookStatus' | 'lastConnectedAt' | 'phoneNumber'>>,
): Promise<void> {
  await Channel.updateOne({ channelId }, { $set: patch }).exec();
}

// ── Type alias used by error classifier ──────────────────

type Boom = import('@hapi/boom').Boom;
