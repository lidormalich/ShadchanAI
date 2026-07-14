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

import { Types } from 'mongoose';
import { Message, Conversation, ChatMapping, FailedInboundMessage, type IMessage } from '../../models/index.js';
import type {
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
  MessageHandleResult,
} from './whatsapp.types.js';
import { findOrCreateConversation } from './conversation.linker.js';
import { findChannelByProviderSessionId, touchChannelActivity } from './channel.manager.js';
import { logWhatsApp, maskPhone } from './whatsapp.logger.js';
import { env } from '../../config/env.js';
import { ChannelRole, MessageDeliveryStatus, MessageDirection, MessageIngestionDecision } from '@shadchanai/shared';
import { enqueueExtraction } from '../extraction/queue.js';
import { publishRealtimeEvent } from '../realtime/realtime.service.js';
import { classifyAndApplyInboundResponse } from '../../modules/matches/match.response.js';
import { downloadInboundMedia } from './media.service.js';

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
      chatJid: msg.chatJid,
      senderName: msg.senderName,
      senderPhone: msg.senderPhone,
      direction: msg.direction,
      contentType: msg.contentType,
      body: msg.body,
      mediaUrl: undefined, // set by downloadInboundMedia right after persist
      mediaCaption: msg.media?.caption,
      mediaMimeType: msg.media?.mimeType,
      externalMessageId: msg.externalMessageId,
      providerSessionId: msg.providerSessionId,
      messageTimestamp: msg.timestamp,
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

  // ── 5b. Fetch image media NOW (non-blocking best-effort) ─
  // WhatsApp media keys expire — deferring the download means losing the
  // image. Failure is tolerable (reconciler retries young messages); the
  // message itself is already safely persisted.
  if (msg.contentType === 'image') {
    void downloadInboundMedia(String(saved._id)).catch(() => {});
  }

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

  // Decision is a pure function (resolveIngestionGate, below) so the
  // gate — including the REQUIRE_EXPLICIT_SOURCE_MAPPING semantics — is
  // unit-testable without a DB.
  const gate = resolveIngestionGate({
    channelRole: channel.role,
    direction: msg.direction,
    effectiveRole,
    requireExplicitMapping: env.REQUIRE_EXPLICIT_SOURCE_MAPPING,
  });

  if (gate === 'ignored_assigned_ignore') {
    logWhatsApp({
      event: 'message_ignored_assigned_ignore',
      channelId: channel.channelId,
      channelRole: channel.role,
      conversationId: String(conversation._id),
      messageId: String(saved._id),
    });
    recordIngestionDecision(saved._id, MessageIngestionDecision.IGNORED_ASSIGNED_IGNORE, effectiveRole);
  } else if (gate === 'ignored_match_sending') {
    logWhatsApp({
      event: 'message_ignored_assigned_match_sending',
      channelId: channel.channelId,
      channelRole: channel.role,
      conversationId: String(conversation._id),
      messageId: String(saved._id),
    });
    recordIngestionDecision(saved._id, MessageIngestionDecision.IGNORED_MATCH_SENDING, effectiveRole);
  } else if (gate === 'ignored_unmapped') {
    logWhatsApp({
      event: 'message_ignored_unmapped_conversation',
      channelId: channel.channelId,
      channelRole: channel.role,
      conversationId: String(conversation._id),
      messageId: String(saved._id),
    });
    recordIngestionDecision(saved._id, MessageIngestionDecision.IGNORED_UNMAPPED, effectiveRole);
  } else if (gate === 'approved') {
    const effectiveText = (msg.body?.trim() || msg.media?.caption?.trim() || '');
    if (effectiveText.length > 0) {
      logWhatsApp({
        event: 'message_accepted_for_ingestion',
        channelId: channel.channelId,
        channelRole: channel.role,
        conversationId: String(conversation._id),
        messageId: String(saved._id),
      });
      recordIngestionDecision(saved._id, MessageIngestionDecision.ACCEPTED, effectiveRole);
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
  // gate === 'not_eligible' → no-op (match_sending channel / outbound)

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

    // Match-domain decisioning (side resolution, classifier confidence
    // policy, state-machine advance) lives in the matches module. The
    // handler just delegates; this is fire-and-forget and never allowed
    // to break the primary persistence path.
    void classifyAndApplyInboundResponse({ matchId, conversationId, messageId, body })
      .catch((err: unknown) => {
        logWhatsApp({
          event: 'error',
          channelId: channel.channelId,
          channelRole: channel.role,
          messageId,
          errorMessage: `response_detection: ${(err as Error).message}`,
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

export type IngestionGateOutcome =
  | 'not_eligible'
  | 'ignored_assigned_ignore'
  | 'ignored_match_sending'
  | 'ignored_unmapped'
  | 'approved';

/**
 * Pure decision for whether an inbound message feeds the extraction
 * pipeline. Extracted so the gate (and the REQUIRE_EXPLICIT_SOURCE_MAPPING
 * semantics) is unit-testable without a DB.
 *
 *   - Only INBOUND messages on a PROFILES_SOURCE channel are eligible.
 *   - An explicit 'ignore' / 'match_sending' mapping always diverts.
 *   - Otherwise approved iff the chat is mapped 'profiles_source', OR
 *     explicit mapping is not required (requireExplicitMapping=false →
 *     a profiles_source channel ingests by default).
 */
export function resolveIngestionGate(params: {
  channelRole: ChannelRole;
  direction: MessageDirection;
  effectiveRole: 'profiles_source' | 'match_sending' | 'ignore' | undefined;
  requireExplicitMapping: boolean;
}): IngestionGateOutcome {
  const eligible =
    params.channelRole === ChannelRole.PROFILES_SOURCE &&
    params.direction === MessageDirection.INBOUND;
  if (!eligible) return 'not_eligible';
  if (params.effectiveRole === 'ignore') return 'ignored_assigned_ignore';
  if (params.effectiveRole === 'match_sending') return 'ignored_match_sending';
  const approved =
    params.effectiveRole === 'profiles_source' || !params.requireExplicitMapping;
  return approved ? 'approved' : 'ignored_unmapped';
}

/**
 * Persist the ingestion routing verdict on the message so operators can
 * audit *why* a message was/wasn't extracted from the UI — not only by
 * scraping logs. Fire-and-forget: a failure here must never break the
 * primary persistence path, so we only log on error.
 */
function recordIngestionDecision(
  messageId: Types.ObjectId | string,
  decision: MessageIngestionDecision,
  effectiveRole?: string,
): void {
  void Message.updateOne(
    { _id: messageId },
    { $set: { ingestion: { decision, effectiveRole, decidedAt: new Date() } } },
  ).exec().catch((err) => {
    logWhatsApp({
      event: 'error',
      messageId: String(messageId),
      errorMessage: `record_ingestion_decision: ${(err as Error).message}`,
    });
  });
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

// ── Resilient inbound ingestion ──────────────────────────
// handleInboundMessage is the SOLE inbound persistence point. If it throws
// before the Message row is durably written (transient Mongo fault during a
// failover/timeout, or a validation error), the message would otherwise be
// lost forever — Baileys does not redeliver an already-acked message. The
// wrapper below adds bounded inline retries for transient faults and, failing
// that, records the message to a dead-letter store that the replay job drains.
// Replays are safe because persistence is idempotent (unique externalMessageId).

const INGEST_MAX_INLINE_ATTEMPTS = 3;
const INGEST_INLINE_BACKOFF_MS = 250;
const REPLAY_MAX_ATTEMPTS = 10;
const REPLAY_BACKOFF_BASE_MS = 60_000; // 1 min, grows per attempt

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Transient/infra DB errors worth retrying (vs. permanent validation errors). */
export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if (isDuplicateKeyError(err)) return false;
  const e = err as { name?: string; code?: number; message?: string };
  const name = e.name ?? '';
  if (
    name === 'MongoNetworkError' || name === 'MongoNetworkTimeoutError' ||
    name === 'MongoServerSelectionError' || name === 'MongoNotConnectedError' ||
    name === 'MongoTimeoutError' || name === 'MongoPoolClearedError'
  ) return true;
  // Retryable server codes: not-primary / interruptions / write conflicts / timeouts.
  const retryableCodes = new Set([6, 7, 89, 91, 112, 189, 251, 262, 9001, 10107, 11600, 11602, 13435, 13436]);
  if (typeof e.code === 'number' && retryableCodes.has(e.code)) return true;
  const msg = (e.message ?? '').toLowerCase();
  if (
    msg.includes('timed out') || msg.includes('not primary') ||
    msg.includes('pool is draining') || msg.includes('connection') || msg.includes('socket')
  ) return true;
  return false;
}

/**
 * Persist an inbound message with bounded retry + dead-letter durability.
 * The provider event bridge should call THIS (not handleInboundMessage
 * directly) so a transient DB fault never silently drops a message.
 */
export async function ingestInboundMessage(
  msg: NormalizedInboundMessage,
): Promise<MessageHandleResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= INGEST_MAX_INLINE_ATTEMPTS; attempt++) {
    try {
      return await handleInboundMessage(msg);
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || attempt === INGEST_MAX_INLINE_ATTEMPTS) break;
      await sleep(INGEST_INLINE_BACKOFF_MS * attempt);
    }
  }
  // Inline retries exhausted (or a permanent error). Record to the dead-letter
  // store for later replay. If even THIS write fails (full DB outage), rethrow
  // so the caller logs an error event — the only remaining signal.
  try {
    await deadLetterInboundMessage(msg, lastErr);
  } catch {
    throw lastErr;
  }
  return { stored: false, skipReason: 'deferred_failed' };
}

async function deadLetterInboundMessage(msg: NormalizedInboundMessage, err: unknown): Promise<void> {
  const e = (err ?? {}) as { name?: string; message?: string };
  const now = new Date();
  await FailedInboundMessage.updateOne(
    { externalMessageId: msg.externalMessageId },
    {
      $set: {
        providerSessionId: msg.providerSessionId,
        normalized: msg as unknown as Record<string, unknown>,
        errorName: e.name,
        errorMessage: e.message ?? String(err),
        status: 'pending',
        lastTriedAt: now,
        nextRetryAt: new Date(now.getTime() + REPLAY_BACKOFF_BASE_MS),
      },
      $setOnInsert: { firstFailedAt: now, attempts: 0 },
    },
    { upsert: true },
  ).exec();
  logWhatsApp({
    event: 'error',
    externalMessageId: msg.externalMessageId,
    participantPhoneMasked: maskPhone(msg.participantPhone),
    errorMessage: `inbound dead-lettered after retries: ${e.message ?? String(err)}`,
  });
}

/**
 * Replay pending dead-lettered inbound messages whose backoff has elapsed.
 * Called by the background job. Idempotent — already-persisted messages
 * resolve via the duplicate path (handleInboundMessage returns, doesn't throw).
 */
export async function replayFailedInboundMessages(
  limit = 50,
): Promise<{ resolved: number; failed: number; parked: number }> {
  const now = new Date();
  const due = await FailedInboundMessage.find({ status: 'pending', nextRetryAt: { $lte: now } })
    .sort({ nextRetryAt: 1 })
    .limit(limit)
    .exec();

  let resolved = 0, failed = 0, parked = 0;
  for (const row of due) {
    try {
      await handleInboundMessage(row.normalized as unknown as NormalizedInboundMessage);
      row.status = 'resolved';
      row.resolvedAt = new Date();
      resolved++;
    } catch (err) {
      row.attempts += 1;
      row.lastTriedAt = new Date();
      row.errorMessage = (err as Error)?.message ?? String(err);
      if (row.attempts >= REPLAY_MAX_ATTEMPTS) {
        row.status = 'parked';
        parked++;
      } else {
        row.nextRetryAt = new Date(Date.now() + REPLAY_BACKOFF_BASE_MS * row.attempts);
        failed++;
      }
    }
    await row.save();
  }
  return { resolved, failed, parked };
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
