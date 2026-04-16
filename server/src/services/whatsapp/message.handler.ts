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

import { Message, Conversation, ChatMapping, type IMessage } from '../../models/index.js';
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
import { publishRealtimeEvent } from '../realtime/realtime.service.js';
import { classifyResponse } from './response.classifier.js';
import { applyInboundResponse } from '../../modules/matches/match.service.js';
import { MatchSuggestion } from '../../models/index.js';
import { classifyMessage as aiClassifyMessage } from '../ai/ai.service.js';

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
    chatJid: msg.chatJid,
    chatType: msg.chatType,
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

  // ── 6b. Publish realtime event for live conversation UI ──
  publishRealtimeEvent('conversation.updated', {
    conversationId: String(conversation._id),
    channelId: channel.channelId,
    channelRole: channel.role,
    direction: msg.direction,
    messageId: String(saved._id),
    at: msg.timestamp?.toISOString?.() ?? new Date().toISOString(),
  });

  // ── 7. Enqueue profile extraction ─────────────────────
  // PRE-PILOT GATE (authoritative ordering):
  //   1. ChatMapping keyed by (channelId, chatJid) — the real
  //      mapping the operator set from the discovery UI.
  //   2. Conversation.assignedRole — legacy fallback for the
  //      very first pilot rows that were mapped via conversations.
  //
  // Channel must still be PROFILES_SOURCE — match_sending channels
  // never feed the extraction pipeline regardless of mapping.
  const ingestionRoleEligible =
    channel.role === ChannelRole.PROFILES_SOURCE &&
    msg.direction === MessageDirection.INBOUND;

  let effectiveRole: 'profiles_source' | 'match_sending' | 'ignore' | undefined;
  if (ingestionRoleEligible && msg.chatJid) {
    const mapping = await ChatMapping.findOne({
      channelId: channel.channelId,
      chatJid: msg.chatJid,
    }).select('role').lean().exec();
    if (mapping) effectiveRole = mapping.role;
  }
  if (ingestionRoleEligible && !effectiveRole) {
    effectiveRole = conversation.assignedRole;
  }

  const conversationApprovedForIngestion = effectiveRole === 'profiles_source';

  if (ingestionRoleEligible && effectiveRole === 'ignore') {
    logWhatsApp({
      event: 'message_ignored_assigned_ignore',
      channelId: channel.channelId,
      channelRole: channel.role,
      conversationId: String(conversation._id),
      messageId: String(saved._id),
    });
  } else if (ingestionRoleEligible && effectiveRole === 'match_sending') {
    logWhatsApp({
      event: 'message_ignored_assigned_match_sending',
      channelId: channel.channelId,
      channelRole: channel.role,
      conversationId: String(conversation._id),
      messageId: String(saved._id),
    });
  } else if (ingestionRoleEligible && !conversationApprovedForIngestion) {
    logWhatsApp({
      event: 'message_ignored_unmapped_conversation',
      channelId: channel.channelId,
      channelRole: channel.role,
      conversationId: String(conversation._id),
      messageId: String(saved._id),
    });
  } else if (ingestionRoleEligible && conversationApprovedForIngestion) {
    const effectiveText = (msg.body?.trim() || msg.media?.caption?.trim() || '');
    if (effectiveText.length > 0) {
      logWhatsApp({
        event: 'message_accepted_for_ingestion',
        channelId: channel.channelId,
        channelRole: channel.role,
        conversationId: String(conversation._id),
        messageId: String(saved._id),
      });
      void enqueueExtraction(String(saved._id)).catch((err) => {
        logWhatsApp({
          event: 'error',
          channelId: channel.channelId,
          channelRole: channel.role,
          messageId: String(saved._id),
          errorMessage: `enqueueExtraction: ${(err as Error).message}`,
        });
      });
    } else {
      // Persist an explicit no-text skip so the operator's extraction
      // badge on this message reads as "not a profile (no text)"
      // rather than "no extraction attempted".
      void Message.updateOne(
        { _id: saved._id, 'extraction.status': { $exists: false } },
        {
          $set: {
            extraction: {
              status: 'skipped_not_profile',
              method: 'regex',
              attemptedAt: new Date(),
              completedAt: new Date(),
              confidence: 0,
              failureReason: 'no_text',
            },
          },
        },
      ).exec().catch((err) => {
        logWhatsApp({
          event: 'error',
          channelId: channel.channelId,
          channelRole: channel.role,
          messageId: String(saved._id),
          errorMessage: `mark_no_text_skip: ${(err as Error).message}`,
        });
      });
    }
  }

  // ── 7b. Auto-detect match response on match_sending channels ──
  // If this inbound message arrived on a conversation linked to a
  // sent proposal, classify it and persist a sideX response so the
  // dashboard's new_response row is reachable without operator action.
  // Fire-and-forget; never allowed to break the primary persistence path.
  if (
    channel.role === ChannelRole.MATCH_SENDING &&
    msg.direction === MessageDirection.INBOUND &&
    conversation.matchSuggestionId &&
    msg.body && msg.body.trim().length > 0
  ) {
    const conversationId = String(conversation._id);
    const matchId = String(conversation.matchSuggestionId);
    const messageId = String(saved._id);
    const body = msg.body;

    void (async (): Promise<void> => {
      try {
        const match = await MatchSuggestion.findById(matchId).lean().exec();
        if (!match) return;

        // Determine which side this conversation represents.
        let side: 'a' | 'b' | null = null;
        if (String(match.conversationIds?.sideA ?? '') === conversationId) side = 'a';
        else if (String(match.conversationIds?.sideB ?? '') === conversationId) side = 'b';
        if (!side) return; // conversation linked to match but not bound to a specific side

        // Deterministic classification first.
        const regex = classifyResponse(body);
        let status: 'accepted' | 'declined' | 'considering' = regex.status;
        let classifier: 'regex' | 'ai' = 'regex';
        let confidence = regex.confidence;

        // Confidence policy (Phase 7 hardening):
        //   - Regex ≥ 0.6  → apply regex verdict.
        //   - Regex < 0.6  → AI advisory. AI may ONLY escalate to a
        //     decisive accepted/declined when its own confidence
        //     crosses AI_MIN_CONFIDENCE; otherwise status is held
        //     at "considering". Prevents a low-confidence LLM reply
        //     from mis-advancing the match state machine.
        const AI_MIN_CONFIDENCE = 0.7;
        if (regex.confidence < 0.6) {
          try {
            const ai = await aiClassifyMessage(
              { text: body, context: { purpose: 'match_proposal' } },
              { messageId },
            );
            const sentiment = ai.data.sentiment;
            const aiConfidence = ai.data.confidence ?? 0;
            const decisive = aiConfidence >= AI_MIN_CONFIDENCE;

            if (sentiment === 'positive' && decisive) {
              status = 'accepted';
            } else if (sentiment === 'negative' && decisive) {
              status = 'declined';
            } else {
              // non-decisive OR below confidence floor → conservative.
              // Row surfaces on dashboard as "considering" for operator review.
              status = 'considering';
            }
            classifier = 'ai';
            confidence = aiConfidence;
          } catch {
            // AI unreachable — keep regex verdict (likely 'considering').
          }
        }

        await applyInboundResponse(matchId, side, status, {
          messageId,
          classifier,
          classifierConfidence: confidence,
          rawText: body,
        });
      } catch (err) {
        logWhatsApp({
          event: 'error',
          channelId: channel.channelId,
          channelRole: channel.role,
          messageId,
          errorMessage: `response_detection: ${(err as Error).message}`,
        });
      }
    })();
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
