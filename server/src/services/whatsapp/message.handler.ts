// ═══════════════════════════════════════════════════════════
// ShadchanAI — Message Handler
//
// Idempotent, side-effect-safe message persistence.
//
// Guarantees:
//   - Duplicate externalMessageId values are detected and the
//     second write is a no-op (returns stored=false, skipReason=duplicate).
//   - Unknown channels are skipped with a warning, not errors.
//   - Conversation creation and message insertion happen under a
//     deterministic path — the same webhook replayed N times results
//     in exactly ONE message row and ONE conversation row.
//   - Raw payload is stored with select:false (never in normal queries).
//
// Idempotency strategy:
//   - Message.externalMessageId has a unique sparse index.
//   - We attempt insertOne; on E11000 duplicate-key error we return
//     skipReason='duplicate' without further side effects.
// ═══════════════════════════════════════════════════════════

import { Message, Conversation, type IMessage } from '../../models/index.js';
import type {
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  MessageHandleResult,
} from './whatsapp.types.js';
import { findOrCreateConversation } from './conversation.linker.js';
import { findChannelByProviderSessionId, touchChannelActivity } from './channel.manager.js';
import { logWhatsApp, maskPhone } from './whatsapp.logger.js';
import { ChannelRole, MessageDeliveryStatus, MessageDirection } from '@shadchanai/shared';
import { enqueueExtraction } from '../extraction/queue.js';

// ── Inbound message handling ─────────────────────────────

export async function handleInboundMessage(
  msg: NormalizedInboundMessage,
): Promise<MessageHandleResult> {
  // ── 1. Route to channel ───────────────────────────────
  const channel = await findChannelByProviderSessionId(msg.providerSessionId);
  if (!channel) {
    logWhatsApp({
      event: 'channel_not_found',
      externalMessageId: msg.externalMessageId,
      participantPhoneMasked: maskPhone(msg.participantPhone),
    });
    return { stored: false, skipReason: 'unknown_channel' };
  }

  // ── 2. Fast-path dedup BEFORE creating conversation ───
  // If we've already seen this externalMessageId, skip everything.
  const existing = await Message.findOne({ externalMessageId: msg.externalMessageId })
    .select('_id conversationId')
    .lean()
    .exec();
  if (existing) {
    logWhatsApp({
      event: 'message_duplicate',
      channelId: channel.channelId,
      channelRole: channel.role,
      externalMessageId: msg.externalMessageId,
      messageId: String(existing._id),
    });
    return {
      stored: false,
      skipReason: 'duplicate',
      messageId: String(existing._id),
      conversationId: String(existing.conversationId),
    };
  }

  // ── 3. Find or create conversation ────────────────────
  const { conversation } = await findOrCreateConversation({
    channel,
    participantPhone: msg.participantPhone,
    participantName: msg.participantName,
  });

  // ── 4. Persist message (with belt-and-suspenders dedup) ─
  let saved: IMessage;
  try {
    saved = await Message.create({
      conversationId: conversation._id,
      channelId: channel.channelId,
      channelRole: channel.role,
      accountDisplayName: channel.accountDisplayName,
      direction: msg.direction,
      contentType: msg.contentType,
      body: msg.body,
      mediaUrl: undefined, // resolved later by media-fetch job
      mediaCaption: msg.media?.caption,
      mediaMimeType: msg.media?.mimeType,
      externalMessageId: msg.externalMessageId,
      providerSessionId: msg.providerSessionId,
      deliveryStatus: MessageDeliveryStatus.DELIVERED, // inbound arrived
      rawPayload: msg.rawPayload,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      // Race: another worker inserted it between our check and create
      const raced = await Message.findOne({ externalMessageId: msg.externalMessageId })
        .select('_id conversationId')
        .lean()
        .exec();
      return {
        stored: false,
        skipReason: 'duplicate',
        messageId: raced ? String(raced._id) : undefined,
        conversationId: raced ? String(raced.conversationId) : undefined,
      };
    }
    throw err;
  }

  // ── 5. Update conversation counters (idempotent enough) ──
  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $inc: { unreadCount: 1 },
      $set: {
        lastMessageAt: msg.timestamp,
        lastInboundAt: msg.timestamp,
        needsAction: true,
      },
    },
  ).exec();

  // ── 6. Touch channel activity (non-blocking best-effort) ─
  void touchChannelActivity(channel.channelId, 'inbound').catch(() => {});

  // ── 7. Enqueue profile extraction ─────────────────────
  // Only inbound text on a profiles_source channel qualifies. Everything
  // else (match_sending replies, outbound, media-only) bypasses the
  // extraction pipeline. Fire-and-forget so persistence latency stays
  // decoupled from AI latency.
  if (
    channel.role === ChannelRole.PROFILES_SOURCE &&
    msg.direction === MessageDirection.INBOUND &&
    msg.body && msg.body.trim().length > 0
  ) {
    void enqueueExtraction(String(saved._id)).catch((err) => {
      logWhatsApp({
        event: 'error',
        channelId: channel.channelId,
        channelRole: channel.role,
        messageId: String(saved._id),
        errorMessage: `enqueueExtraction: ${(err as Error).message}`,
      });
    });
  }

  logWhatsApp({
    event: 'message_persisted',
    channelId: channel.channelId,
    channelRole: channel.role,
    accountDisplayName: channel.accountDisplayName,
    conversationId: String(conversation._id),
    messageId: String(saved._id),
    externalMessageId: msg.externalMessageId,
    participantPhoneMasked: maskPhone(msg.participantPhone),
  });

  return {
    stored: true,
    messageId: String(saved._id),
    conversationId: String(conversation._id),
  };
}

// ── Outbound status updates ──────────────────────────────

/**
 * Update an outbound message's delivery state based on a provider
 * status webhook. If the message is unknown (status arrived before
 * the send record was persisted, e.g. out-of-order), we skip rather
 * than fail — a later retry or reconciliation job handles it.
 */
export async function handleStatusUpdate(
  update: NormalizedStatusUpdate,
): Promise<{ updated: boolean; skipReason?: string }> {
  const set: Record<string, unknown> = {
    deliveryStatus: update.status,
  };

  switch (update.status) {
    case MessageDeliveryStatus.SENT:
      set['sentAt'] = update.timestamp;
      break;
    case MessageDeliveryStatus.DELIVERED:
      set['deliveredAt'] = update.timestamp;
      break;
    case MessageDeliveryStatus.READ:
      set['readAt'] = update.timestamp;
      break;
    case MessageDeliveryStatus.FAILED:
      set['failedAt'] = update.timestamp;
      if (update.failureReason) set['failureReason'] = update.failureReason;
      break;
  }

  const result = await Message.updateOne(
    { externalMessageId: update.externalMessageId, direction: 'outbound' },
    { $set: set },
  ).exec();

  if (result.matchedCount === 0) {
    logWhatsApp({
      event: 'status_updated',
      externalMessageId: update.externalMessageId,
      skipReason: 'unknown_message',
    });
    return { updated: false, skipReason: 'unknown_message' };
  }

  logWhatsApp({
    event: 'status_updated',
    externalMessageId: update.externalMessageId,
    status: update.status,
  });

  return { updated: true };
}

// ── Utility ──────────────────────────────────────────────

export function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; name?: string; message?: string };
  if (e.code === 11000) return true;
  if (e.name === 'MongoServerError' && e.message?.includes('E11000')) return true;
  if (e.message?.includes('duplicate key')) return true;
  return false;
}
