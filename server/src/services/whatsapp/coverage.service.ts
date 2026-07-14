// ═══════════════════════════════════════════════════════════
// ShadchanAI — Downtime Coverage Service
//
// WhatsApp queues messages server-side while our linked device is
// offline and flushes them on reconnect — but that queue is
// best-effort, and a dropped message is SILENT. This service turns
// that silence into a signal: a few minutes after a channel
// reconnects from a meaningful offline window, it counts what
// actually arrived (by ORIGINAL send time, which offline-delivered
// messages keep) and flags normally-active mapped chats that
// produced nothing.
//
// Trigger: baileys.client calls noteChannelReconnected() on every
// 'connection open'. Window start = the best persisted estimate of
// when we stopped listening (lastDisconnectAt, falling back to
// lastInboundAt after a hard kill). Short blips are ignored.
//
// This VERIFIES coverage; it does not recover messages. If reports
// show real recurring gaps, active backfill is the follow-up step.
// ═══════════════════════════════════════════════════════════

import { Channel, ChatMapping, Message, CoverageReport, type ICoverageChatEntry } from '../../models/index.js';
import { MessageDirection } from '@shadchanai/shared';
import { COVERAGE } from './whatsapp.constants.js';
import { logWhatsApp } from './whatsapp.logger.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('wa.coverage');

// One pending check per channel — a reconnect that lands while an
// earlier check is still settling replaces it (the newer window
// subsumes the older one's end anyway).
const pendingChecks = new Map<string, ReturnType<typeof setTimeout>>();

// ── Pure computation (unit-testable, no DB) ───────────────

export interface ChatCoverageInput {
  chatJid: string;
  chatName?: string;
  windowCount: number;
  baselineCount: number;
}

/**
 * Decide per-chat coverage entries + suspicion. A chat is suspect when
 * it produced ZERO messages inside the window even though its baseline
 * rate predicts at least SUSPECT_MIN_EXPECTED. Chats quiet in both the
 * baseline and the window are simply quiet chats — never suspect.
 */
export function computeChatCoverage(
  inputs: ChatCoverageInput[],
  windowMs: number,
  baselineDays: number = COVERAGE.BASELINE_DAYS,
  suspectMinExpected: number = COVERAGE.SUSPECT_MIN_EXPECTED,
): ICoverageChatEntry[] {
  const windowDays = windowMs / 86_400_000;
  return inputs.map((c) => {
    const baselinePerDay = baselineDays > 0 ? c.baselineCount / baselineDays : 0;
    const expectedInWindow = baselinePerDay * windowDays;
    return {
      chatJid: c.chatJid,
      chatName: c.chatName,
      windowCount: c.windowCount,
      baselineCount: c.baselineCount,
      baselinePerDay: round2(baselinePerDay),
      expectedInWindow: round2(expectedInWindow),
      suspect: c.windowCount === 0 && expectedInWindow >= suspectMinExpected,
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Best persisted estimate of when the channel stopped listening.
 * Graceful stop / real disconnect stamp lastDisconnectAt; after a hard
 * kill that stamp may be stale or missing, so the most recent of
 * (lastDisconnectAt, lastInboundAt) is the tightest safe window start.
 */
export function resolveOfflineFrom(channel: {
  lastDisconnectAt?: Date | null;
  lastInboundAt?: Date | null;
}): Date | null {
  const candidates = [channel.lastDisconnectAt, channel.lastInboundAt]
    .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

// ── Trigger (called by baileys.client on connection open) ─

/**
 * Note that a channel just (re)connected. If the offline window is
 * meaningful, schedule a coverage check after the settle delay so the
 * offline queue has flushed through ingestion first. Fire-and-forget;
 * never throws into the connection handler.
 */
export async function noteChannelReconnected(channelId: string, reconnectedAt: Date): Promise<void> {
  try {
    const channel = await Channel.findOne({ channelId })
      .select('channelId accountDisplayName lastDisconnectAt lastInboundAt')
      .lean()
      .exec();
    if (!channel) return;

    const offlineFrom = resolveOfflineFrom(channel);
    if (!offlineFrom) return; // first-ever connect — nothing to verify
    const offlineMs = reconnectedAt.getTime() - offlineFrom.getTime();
    if (offlineMs < COVERAGE.MIN_GAP_MS) return; // routine churn

    const existing = pendingChecks.get(channelId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      pendingChecks.delete(channelId);
      void runCoverageCheck({
        channelId,
        accountDisplayName: channel.accountDisplayName,
        offlineFrom,
        offlineTo: reconnectedAt,
      }).catch((err) => {
        log.error({ channelId, error: (err as Error).message }, 'coverage_check_failed');
      });
    }, COVERAGE.SETTLE_MS);
    // Never keep the process alive just for a pending report.
    timer.unref?.();
    pendingChecks.set(channelId, timer);

    log.info(
      { channelId, offlineFrom, offlineHours: round2(offlineMs / 3_600_000), settleMs: COVERAGE.SETTLE_MS },
      'coverage_check_scheduled',
    );
  } catch (err) {
    log.error({ channelId, error: (err as Error).message }, 'coverage_schedule_failed');
  }
}

/** Cancel a pending check (channel stopped again before it fired). */
export function cancelPendingCoverageCheck(channelId: string): void {
  const t = pendingChecks.get(channelId);
  if (t) {
    clearTimeout(t);
    pendingChecks.delete(channelId);
  }
}

// ── The check itself ──────────────────────────────────────

export async function runCoverageCheck(params: {
  channelId: string;
  accountDisplayName?: string;
  offlineFrom: Date;
  offlineTo: Date;
}): Promise<void> {
  const { channelId, accountDisplayName, offlineFrom, offlineTo } = params;
  const offlineMs = offlineTo.getTime() - offlineFrom.getTime();

  const windowFilter = {
    channelId,
    direction: MessageDirection.INBOUND,
    messageTimestamp: { $gte: offlineFrom, $lte: offlineTo },
  };

  // Channel-wide: how much of the window did the offline queue deliver?
  const messagesInWindow = await Message.countDocuments(windowFilter).exec();

  // Per mapped source chat: window count + baseline rate. Baseline uses
  // createdAt (arrival time ≈ send time for live-ingested messages, and
  // pre-deploy rows have no messageTimestamp at all).
  const mappings = await ChatMapping.find({ channelId, role: 'profiles_source' })
    .select('chatJid chatName')
    .lean()
    .exec();

  const baselineStart = new Date(offlineFrom.getTime() - COVERAGE.BASELINE_DAYS * 86_400_000);
  const inputs: ChatCoverageInput[] = await Promise.all(
    mappings.map(async (m) => {
      const [windowCount, baselineCount] = await Promise.all([
        Message.countDocuments({ ...windowFilter, chatJid: m.chatJid }).exec(),
        Message.countDocuments({
          channelId,
          chatJid: m.chatJid,
          direction: MessageDirection.INBOUND,
          createdAt: { $gte: baselineStart, $lt: offlineFrom },
        }).exec(),
      ]);
      return { chatJid: m.chatJid, chatName: m.chatName, windowCount, baselineCount };
    }),
  );

  const chats = computeChatCoverage(inputs, offlineMs);
  const suspectCount = chats.filter((c) => c.suspect).length;

  await CoverageReport.create({
    channelId,
    accountDisplayName,
    offlineFrom,
    offlineTo,
    offlineMs,
    messagesInWindow,
    chats,
    suspectCount,
  });

  logWhatsApp({
    event: 'coverage_report',
    channelId,
    accountDisplayName,
    offlineHours: round2(offlineMs / 3_600_000),
    messagesInWindow,
    mappedChats: chats.length,
    suspectCount,
    suspectChats: chats.filter((c) => c.suspect).map((c) => c.chatName ?? c.chatJid),
  });
}
