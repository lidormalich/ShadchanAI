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
import { handleInboundMessage, handleStatusUpdate } from '../../message.handler.js';
import { logWhatsApp, maskPhone } from '../../whatsapp.logger.js';
import { mapInboundMessage, mapStatusUpdate } from './baileys.mapper.js';

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
        if (!normalized) continue;

        await handleInboundMessage(normalized);
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
