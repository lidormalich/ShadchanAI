// ═══════════════════════════════════════════════════════════
// ShadchanAI — Conversation Service
//
// Read-heavy. Writes allowed: mark-read, explicit link-to-entity.
// Never auto-merges histories across replaced channels.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import type { ChannelRole } from '@shadchanai/shared';
import { AuditActionType, AuditEntityType } from '@shadchanai/shared';
import { Conversation, Message, type IConversation, type IMessage } from '../../models/index.js';
import { audit } from '../../services/audit.service.js';
import { NotFoundError } from '../../utils/errors.js';
import { toSkipLimit, buildSort, makeMeta } from '../../utils/pagination.js';
import {
  getConversationChain,
  linkConversationToMatch,
  linkConversationToInternalCandidate,
  linkConversationToExternalCandidate,
} from '../../services/whatsapp/conversation.linker.js';
import type { ListConversationsQuery, ListMessagesQuery } from './conversation.validator.js';

// ── List ─────────────────────────────────────────────────

export async function listConversations(
  query: ListConversationsQuery,
): Promise<{ items: IConversation[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  const { skip, limit } = toSkipLimit(query);
  const sort = buildSort(query, 'lastMessageAt');

  const filter: Record<string, unknown> = { archivedAt: { $exists: false } };
  if (query.channelId) filter['channelId'] = query.channelId;
  if (query.channelRole) filter['channelRole'] = query.channelRole;
  if (query.purpose) filter['purpose'] = query.purpose;
  if (query.needsAction !== undefined) filter['needsAction'] = query.needsAction;
  if (query.hasUnread) filter['unreadCount'] = { $gt: 0 };
  if (query.internalCandidateId) filter['internalCandidateId'] = new Types.ObjectId(query.internalCandidateId);
  if (query.externalCandidateId) filter['externalCandidateId'] = new Types.ObjectId(query.externalCandidateId);
  if (query.matchSuggestionId) filter['matchSuggestionId'] = new Types.ObjectId(query.matchSuggestionId);

  const [items, total] = await Promise.all([
    Conversation.find(filter).sort(sort).skip(skip).limit(limit).lean().exec(),
    Conversation.countDocuments(filter).exec(),
  ]);

  return {
    items: items as unknown as IConversation[],
    total,
    meta: makeMeta(query.page, query.limit, total),
  };
}

export async function getConversationById(id: string): Promise<IConversation> {
  const doc = await Conversation.findById(id).exec();
  if (!doc) throw new NotFoundError('Conversation', id);
  return doc;
}

// ── Messages for a conversation ──────────────────────────

export async function listMessagesForConversation(
  conversationId: string,
  query: ListMessagesQuery,
): Promise<{ items: IMessage[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  const { skip, limit } = toSkipLimit(query);
  const filter: Record<string, unknown> = { conversationId: new Types.ObjectId(conversationId) };
  if (query.before || query.after) {
    const range: Record<string, Date> = {};
    if (query.after) range['$gte'] = query.after;
    if (query.before) range['$lte'] = query.before;
    filter['createdAt'] = range;
  }
  const [items, total] = await Promise.all([
    Message.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean().exec(),
    Message.countDocuments(filter).exec(),
  ]);
  return {
    items: items as unknown as IMessage[],
    total,
    meta: makeMeta(query.page, query.limit, total),
  };
}

// ── Mark read ────────────────────────────────────────────

export async function markConversationRead(id: string, performedBy: string): Promise<IConversation> {
  const doc = await getConversationById(id);
  const before = doc.toObject();
  doc.unreadCount = 0;
  doc.needsAction = false;
  await doc.save();
  await audit({
    entityType: AuditEntityType.CONVERSATION,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { scope: 'mark_read' },
  });
  return doc;
}

// ── Explicit linking (never automatic) ───────────────────

export async function linkConversation(
  id: string,
  links: { internalCandidateId?: string; externalCandidateId?: string; matchSuggestionId?: string },
  performedBy: string,
): Promise<IConversation> {
  const before = (await getConversationById(id)).toObject();
  if (links.matchSuggestionId) await linkConversationToMatch(id, links.matchSuggestionId);
  if (links.internalCandidateId) await linkConversationToInternalCandidate(id, links.internalCandidateId);
  if (links.externalCandidateId) await linkConversationToExternalCandidate(id, links.externalCandidateId);
  const after = await getConversationById(id);
  await audit({
    entityType: AuditEntityType.CONVERSATION,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: after.toObject(),
    metadata: { scope: 'link', ...links },
  });
  return after;
}

// ── Channel-role listing ─────────────────────────────────

export async function listConversationsByChannelRole(
  role: ChannelRole,
  query: ListConversationsQuery,
): Promise<{ items: IConversation[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  return listConversations({ ...query, channelRole: role });
}

// ── Chain across replaced channels ───────────────────────

export async function getChain(conversationId: string): Promise<IConversation[]> {
  return getConversationChain(conversationId);
}

// ═══════════════════════════════════════════════════════════
// Outbound text reply in a conversation (human-approved)
//
// Secondary send surface — for replying to a candidate/family in
// an already-open conversation. Gates:
//   - conversation exists + not archived
//   - channel.role === match_sending (NEVER on profiles_source)
//   - pre-flight audit, socket send, success/failed audit
//
// Match-level state is NOT modified here. If you need the match
// state machine to advance, use matches.sendProposal instead.
// ═══════════════════════════════════════════════════════════

import { Channel as ChannelModel } from '../../models/index.js';
import { MessageDirection, MessageDeliveryStatus, ChannelRole as ChannelRoleEnum } from '@shadchanai/shared';
import { phoneToJid, sendTextFromChannel } from '../../services/whatsapp/whatsapp.service.js';
import { checkAndConsumeSendQuota } from '../../services/whatsapp/send.rate-limiter.js';
import { BusinessRuleError } from '../../utils/errors.js';

export interface SendConvoMessageInput {
  body: string;
  performedBy: string;
}

export async function sendMessageInConversation(
  conversationId: string,
  input: SendConvoMessageInput,
): Promise<{ messageId: string; externalMessageId: string }> {
  const conv = await getConversationById(conversationId);
  if (conv.archivedAt) {
    throw new BusinessRuleError('Conversation is archived', { code: 'conversation_archived' });
  }
  if (!conv.participantPhone) {
    throw new BusinessRuleError('Conversation has no participant phone', { code: 'no_participant_phone' });
  }

  const channel = await ChannelModel.findOne({ channelId: conv.channelId }).exec();
  if (!channel) throw new BusinessRuleError('Channel not found', { code: 'channel_not_found' });
  if (channel.role !== ChannelRoleEnum.MATCH_SENDING) {
    throw new BusinessRuleError(
      'Replies can only be sent from a match_sending channel',
      { code: 'wrong_channel_role', role: channel.role },
    );
  }

  const jid = phoneToJid(conv.participantPhone);

  checkAndConsumeSendQuota({ channelId: channel.channelId, userId: input.performedBy });

  await audit({
    entityType: AuditEntityType.MESSAGE,
    entityId: conversationId,
    actionType: AuditActionType.MESSAGE_SENT,
    performedBy: input.performedBy,
    metadata: {
      stage: 'attempt',
      conversationId,
      channelId: channel.channelId,
      bodyBytes: Buffer.byteLength(input.body, 'utf8'),
    },
  });

  let externalMessageId: string;
  try {
    externalMessageId = await sendTextFromChannel({
      channelId: channel.channelId,
      jid,
      body: input.body,
    });
  } catch (err) {
    const failed = await Message.create({
      conversationId: conv._id,
      channelId: channel.channelId,
      channelRole: channel.role,
      accountDisplayName: channel.accountDisplayName,
      direction: MessageDirection.OUTBOUND,
      contentType: 'text',
      body: input.body,
      providerSessionId: channel.providerSessionId ?? channel.channelId,
      deliveryStatus: MessageDeliveryStatus.FAILED,
      failedAt: new Date(),
      failureReason: (err as Error).message,
    });
    await audit({
      entityType: AuditEntityType.MESSAGE,
      entityId: String(failed._id),
      actionType: AuditActionType.MESSAGE_SENT,
      performedBy: input.performedBy,
      metadata: { stage: 'failed', conversationId, channelId: channel.channelId, error: (err as Error).message },
    });
    throw new BusinessRuleError('Send failed: ' + (err as Error).message, { code: 'send_failed' });
  }

  const saved = await Message.create({
    conversationId: conv._id,
    channelId: channel.channelId,
    channelRole: channel.role,
    accountDisplayName: channel.accountDisplayName,
    direction: MessageDirection.OUTBOUND,
    contentType: 'text',
    body: input.body,
    externalMessageId,
    providerSessionId: channel.providerSessionId ?? channel.channelId,
    deliveryStatus: MessageDeliveryStatus.SENT,
    sentAt: new Date(),
  });

  await Conversation.updateOne(
    { _id: conv._id },
    { $set: { lastMessageAt: saved.createdAt, lastOutboundAt: saved.sentAt } },
  ).exec();

  await audit({
    entityType: AuditEntityType.MESSAGE,
    entityId: String(saved._id),
    actionType: AuditActionType.MESSAGE_SENT,
    performedBy: input.performedBy,
    metadata: {
      stage: 'success',
      conversationId,
      channelId: channel.channelId,
      externalMessageId,
    },
  });

  return { messageId: String(saved._id), externalMessageId };
}
