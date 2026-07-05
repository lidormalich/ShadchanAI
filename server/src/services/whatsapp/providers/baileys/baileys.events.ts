// ═══════════════════════════════════════════════════════════
// ShadchanAI — Baileys Events Bridge
//
// Wires a Baileys socket to the downstream (provider-neutral)
// handlers. This file does NOT import models or do DB work —
// it translates socket events to normalized calls into the
// existing message.handler / channel.manager layer.
// ═══════════════════════════════════════════════════════════

import type { WASocket, WAMessageUpdate } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import type { IChannel } from '../../../../models/index.js';
import { ingestInboundMessage, handleStatusUpdate } from '../../message.handler.js';
import { logWhatsApp, maskPhone } from '../../whatsapp.logger.js';
import { resolveLidToPhone } from '../../lid-resolver.js';
import { mapInboundMessage, mapStatusUpdate } from './baileys.mapper.js';
import type { NormalizedInboundMessage } from '../../whatsapp.types.js';

export interface EventBridgeContext {
  channel: IChannel;
  onConnectionUpdate: (update: ConnectionUpdate) => void;
}

export interface ConnectionUpdate {
  connection?: 'open' | 'connecting' | 'close';
  qr?: string;
  isNewLogin?: boolean;
  lastDisconnect?: { error?: Error; date?: Date };
}

/**
 * Attach our listeners to the socket. Idempotent — callers should
 * only call once per socket instance. Errors inside each listener
 * are caught so one bad event doesn't take down the whole channel.
 */
export function wireEvents(sock: WASocket, ctx: EventBridgeContext): void {
  const { channel, onConnectionUpdate } = ctx;

  // Anonymous "…@lid" group senders: translate to the real phone via group
  // metadata before persisting. Best-effort — a failed lookup just leaves
  // senderPhone empty, exactly as if WhatsApp hid the number.
  const enrichSenderPhone = async (normalized: NormalizedInboundMessage): Promise<void> => {
    if (normalized.chatType !== 'group' || normalized.senderPhone || !normalized.senderLid) return;
    const phone = await resolveLidToPhone(sock, channel, normalized.chatJid, normalized.senderLid);
    if (phone) normalized.senderPhone = phone;
  };

  // ── Connection lifecycle ───────────────────────────────
  sock.ev.on('connection.update', (update) => {
    try {
      onConnectionUpdate(update as ConnectionUpdate);
    } catch (err) {
      logWhatsApp({
        event: 'error',
        channelId: channel.channelId,
        channelRole: channel.role,
        errorMessage: `connection.update handler: ${(err as Error).message}`,
      });
    }
  });

  // ── Inbound messages ───────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = new incoming; 'append' = historical backfill
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      try {
        // Skip our own sends — status updates cover outbound tracking
        if (msg.key?.fromMe === true) continue;

        const normalized = mapInboundMessage(msg, channel);
        if (!normalized) {
          // Visibility into anything we couldn't normalize (genuinely
          // unsupported types, or messages missing an id/sender jid) so
          // dropped messages are never fully silent.
          logWhatsApp({
            event: 'message_skipped_unsupported',
            channelId: channel.channelId,
            channelRole: channel.role,
            externalMessageId: msg.key?.id ?? undefined,
            participantPhoneMasked: maskPhone(msg.key?.remoteJid ?? undefined),
            contentKey: msg.message ? Object.keys(msg.message)[0] ?? 'empty' : 'empty',
          });
          continue;
        }

        await enrichSenderPhone(normalized);
        await ingestInboundMessage(normalized);
      } catch (err) {
        logWhatsApp({
          event: 'error',
          channelId: channel.channelId,
          channelRole: channel.role,
          externalMessageId: msg.key?.id ?? undefined,
          participantPhoneMasked: maskPhone(msg.key?.remoteJid ?? undefined),
          errorMessage: `inbound handler: ${(err as Error).message}`,
        });
      }
    }
  });

  // ── History sync (older messages pushed by WhatsApp) ───
  // Fires on initial connect and in response to fetchMessageHistory
  // (see BaileysClient.requestHistorySync). We route each historical
  // message through the SAME inbound path as live messages, so it lands
  // subject to the ingestion gate: unmapped chats accumulate as pending,
  // mapped profiles_source chats extract. Idempotent via externalMessageId.
  sock.ev.on('messaging-history.set', async (payload) => {
    const messages = (payload as { messages?: unknown[] })?.messages ?? [];
    for (const raw of messages) {
      const msg = raw as Parameters<typeof mapInboundMessage>[0];
      try {
        if (msg?.key?.fromMe === true) continue;
        const normalized = mapInboundMessage(msg, channel);
        if (!normalized) continue;
        await enrichSenderPhone(normalized);
        await ingestInboundMessage(normalized);
      } catch (err) {
        logWhatsApp({
          event: 'error',
          channelId: channel.channelId,
          channelRole: channel.role,
          externalMessageId: msg?.key?.id ?? undefined,
          errorMessage: `history-set handler: ${(err as Error).message}`,
        });
      }
    }
  });

  // ── Message status updates ─────────────────────────────
  sock.ev.on('messages.update', async (updates: WAMessageUpdate[]) => {
    for (const u of updates) {
      try {
        const normalized = mapStatusUpdate(u, channel);
        if (!normalized) continue;
        await handleStatusUpdate(normalized);
      } catch (err) {
        logWhatsApp({
          event: 'error',
          channelId: channel.channelId,
          channelRole: channel.role,
          externalMessageId: u.key?.id ?? undefined,
          errorMessage: `status handler: ${(err as Error).message}`,
        });
      }
    }
  });
}

/**
 * Classify a Baileys disconnect error so the client knows
 * whether to reconnect or mark the session as logged out.
 *
 * Baileys surfaces disconnect reasons via @hapi/boom statusCode.
 * The most important ones:
 *   - 401 (loggedOut): credentials were invalidated → purge session, mark logged_out
 *   - 403: banned → mark suspended
 *   - 408 / 428 / 500 / 515: transient → reconnect
 *   - 440 (connectionReplaced): another device took over → mark replaced
 */
export function classifyDisconnect(err: unknown): {
  kind: 'reconnect' | 'logged_out' | 'replaced' | 'suspended' | 'unknown';
  statusCode?: number;
  message: string;
} {
  if (err instanceof Boom) {
    const code = err.output?.statusCode ?? 0;
    if (code === 401) return { kind: 'logged_out', statusCode: code, message: err.message };
    if (code === 403) return { kind: 'suspended', statusCode: code, message: err.message };
    if (code === 440) return { kind: 'replaced', statusCode: code, message: err.message };
    // 408 / 428 / 500 / 515 and everything else → transient
    return { kind: 'reconnect', statusCode: code, message: err.message };
  }
  return { kind: 'unknown', message: (err as Error)?.message ?? 'unknown disconnect' };
}
