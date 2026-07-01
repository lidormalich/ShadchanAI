// ═══════════════════════════════════════════════════════════
// ShadchanAI — WhatsApp Connection Watchdog
//
// Keeps sessions ONLINE. This is the self-heal counterpart to the
// per-client reconnect loop: once a client exhausts its transient
// reconnect budget the circuit opens and it stops trying (status
// SUSPENDED, statusReason 'reconnect_circuit_open') until a human
// clicks "reconnect". The watchdog closes that gap — it periodically
// finds channels that SHOULD be connected but aren't and revives them.
//
// It deliberately does NOT cycle healthy connections. Cycling a live
// Baileys socket invites connectionReplaced (440) races and drops
// inbound messages during the offline window. We only touch sessions
// that are already down and recoverable.
//
// Recoverable  → revive (reset circuit + reconnect):
//   - status SUSPENDED + statusReason 'reconnect_circuit_open'
//   - status DISCONNECTED
//   - status ACTIVE but the live client is missing / idle / disconnected
//       (e.g. process restarted without auto-start)
//
// NOT recoverable → left for a human:
//   - status REPLACED            (another device owns the session)
//   - status RATE_LIMITED        (must back off, not hammer)
//   - live client state 'logged_out' (needs a fresh QR scan)
//   - SUSPENDED for any other reason (ban / explicit logout)
// ═══════════════════════════════════════════════════════════

import { ChannelStatus } from '@shadchanai/shared';
import { Channel } from '../../models/index.js';
import { reconnectChannel } from './channel.manager.js';
import { getChannelClient } from './providers/baileys/baileys.client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('wa-watchdog');

/** Marker set by the client's circuit breaker when it gives up reconnecting. */
const CIRCUIT_OPEN_REASON = 'reconnect_circuit_open';

/** Live client states that mean "healthy or already working" — never touch. */
const HEALTHY_STATES = new Set(['connected', 'connecting', 'reconnecting', 'pending_pairing']);

export interface WatchdogResult {
  /** Channels considered for revival this pass. */
  scanned: number;
  /** Channel ids we triggered a reconnect for. */
  revived: string[];
  /** Channels left untouched (healthy, mid-connect, or needing a human). */
  skipped: number;
}

/**
 * One watchdog pass. Idempotent and safe to run on an interval:
 * channels already connecting / reconnecting are skipped, so it never
 * fights an in-flight reconnect.
 */
export async function runConnectionWatchdog(): Promise<WatchdogResult> {
  const candidates = await Channel.find({
    $or: [
      { status: ChannelStatus.ACTIVE },
      { status: ChannelStatus.DISCONNECTED },
      { status: ChannelStatus.SUSPENDED, statusReason: CIRCUIT_OPEN_REASON },
    ],
  })
    .select('channelId status statusReason')
    .lean()
    .exec();

  const revived: string[] = [];
  let skipped = 0;

  for (const ch of candidates) {
    const state = getChannelClient(ch.channelId)?.status.state;

    // Healthy or mid-handshake → leave alone.
    if (state && HEALTHY_STATES.has(state)) {
      skipped++;
      continue;
    }
    // Logged out → needs a fresh QR; auto-reconnect can't fix it.
    if (state === 'logged_out') {
      skipped++;
      continue;
    }

    // No live client, or state is idle/disconnected → revive it.
    try {
      await reconnectChannel(ch.channelId);
      // Stamp self-heal telemetry so the UI can show auto-recovery without
      // log scraping. Best-effort — never let it fail the revive.
      await Channel.updateOne(
        { channelId: ch.channelId },
        { $set: { lastAutoReconnectAt: new Date() }, $inc: { autoReconnectCount: 1 } },
      ).exec().catch(() => undefined);
      revived.push(ch.channelId);
      log.info(
        { channelId: ch.channelId, prevStatus: ch.status, clientState: state ?? 'no_client' },
        'watchdog revived channel',
      );
    } catch (err) {
      log.error(
        { channelId: ch.channelId, err: (err as Error).message },
        'watchdog reconnect failed',
      );
    }
  }

  if (revived.length > 0) {
    log.info({ scanned: candidates.length, revived: revived.length, skipped }, 'watchdog pass complete');
  }
  return { scanned: candidates.length, revived, skipped };
}
