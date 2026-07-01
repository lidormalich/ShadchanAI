// ═══════════════════════════════════════════════════════════
// ShadchanAI — Conversation Linker
//
// Deterministic conversation find-or-create logic.
//
// Identity priority (STRICT ORDER):
//   1. Stable channel + participant (primary key)
//   2. Known internalCandidate reference when the channel's prior
//      conversations were linked
//   3. Known externalCandidate reference
//   4. Existing matchSuggestion reference
//
// Phone is NEVER the primary source of truth. Phone is used only
// as a participant hint within a specific channel + role.
//
// When a new channel supersedes an old one (replacement chain),
// the new conversation gets `supersedesConversationId` and
// `replacedChannelOriginId` set for UI continuity, but message
// history stays on the old conversation.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { ChannelRole, ConversationPurpose } from '@shadchanai/shared';
import { Conversation, Channel, type IConversation, type IChannel } from '../../models/index.js';
import { logWhatsApp, maskPhone } from './whatsapp.logger.js';

// ── Link inputs ──────────────────────────────────────────

export interface LinkConversationInput {
  channel: IChannel;
  participantPhone: string;
  participantName?: string;
  /** Raw WhatsApp chat JID — passed through from the inbound mapper.
   *  Enables the ChatMapping ingestion gate to correlate conversations
   *  to WhatsApp chats by jid, not only by participant phone. */
  chatJid?: string;
  chatType?: 'group' | 'private';
  /** Optional known links (skip lookup when caller has them) */
  internalCandidateId?: string;
  externalCandidateId?: string;
  matchSuggestionId?: string;
}

// ── Find-or-create ───────────────────────────────────────

/**
 * Find or create a conversation for a given channel + participant.
 *
 * Uniqueness is scoped to (channelId, participantPhone). We use
 * participantPhone only to disambiguate within a channel — NOT
 * as a global candidate identity. Phone is a hint, not truth.
 *
 * If the channel was created as a replacement of a previous channel,
 * and the previous channel has a conversation with the same
 * participantPhone, we set continuity metadata on the NEW
 * conversation — but we do NOT merge histories.
 */
export async function findOrCreateConversation(
  input: LinkConversationInput,
): Promise<{ conversation: IConversation; created: boolean }> {
  const { channel, participantPhone } = input;

  // ── 1. Primary lookup: (channelId, participantPhone) ────
  const existing = await Conversation.findOne({
    channelId: channel.channelId,
    channelRole: channel.role,
    participantPhone,
    archivedAt: { $exists: false },
  }).exec();

  if (existing) {
    // Top up links if caller provided new info
    await fillInCandidateLinks(existing, input);
    logWhatsApp({
      event: 'conversation_linked',
      channelId: channel.channelId,
      channelRole: channel.role,
      accountDisplayName: channel.accountDisplayName,
      conversationId: String(existing._id),
      participantPhoneMasked: maskPhone(participantPhone),
    });
    return { conversation: existing, created: false };
  }

  // ── 2. No existing — check continuity from replaced channel ──
  let supersedesConversationId: Types.ObjectId | undefined;
  let replacedChannelOriginId: string | undefined;

  if (channel.replacesChannelId) {
    const priorConv = await Conversation.findOne({
      channelId: channel.replacesChannelId,
      participantPhone,
    }).sort({ createdAt: -1 }).exec();

    if (priorConv) {
      supersedesConversationId = priorConv._id as Types.ObjectId;
      replacedChannelOriginId = channel.replacesChannelId;
    }
  }

  // ── 3. Create new conversation (history is NOT merged) ──
  const purpose = channel.role === ChannelRole.PROFILES_SOURCE
    ? ConversationPurpose.PROFILE_INTAKE
    : ConversationPurpose.MATCH_PROPOSAL;

  const created = await Conversation.create({
    channelId: channel.channelId,
    channelRole: channel.role,
    accountDisplayName: channel.accountDisplayName,
    participantPhone,
    participantName: input.participantName,
    chatJid: input.chatJid,
    chatType: input.chatType,
    internalCandidateId: toObjectId(input.internalCandidateId),
    externalCandidateId: toObjectId(input.externalCandidateId),
    matchSuggestionId: toObjectId(input.matchSuggestionId),
    purpose,
    isActive: true,
    needsAction: false,
    unreadCount: 0,
    supersedesConversationId,
    replacedChannelOriginId,
  });

  logWhatsApp({
    event: 'conversation_created',
    channelId: channel.channelId,
    channelRole: channel.role,
    accountDisplayName: channel.accountDisplayName,
    conversationId: String(created._id),
    participantPhoneMasked: maskPhone(participantPhone),
    supersedesConversationId: supersedesConversationId ? String(supersedesConversationId) : undefined,
    replacedChannelOriginId,
  });

  return { conversation: created, created: true };
}

// ── Candidate-link top-up ────────────────────────────────
//
// If a conversation was created before we knew which candidate
// it belonged to, and the caller now has that info, patch the
// conversation record. Never overwrite existing links.

async function fillInCandidateLinks(
  conversation: IConversation,
  input: LinkConversationInput,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  // Backfill chat identity on conversations created before chatJid/chatType
  // were threaded through (or by a legacy path). Without this an old group
  // conversation keeps chatJid=null forever and discovery can't place it on
  // its real "@g.us" jid — so it never shows in mappings/pending correctly.
  if (!conversation.chatJid && input.chatJid) {
    patch['chatJid'] = input.chatJid;
  }
  if (!conversation.chatType && input.chatType) {
    patch['chatType'] = input.chatType;
  }
  if (!conversation.internalCandidateId && input.internalCandidateId) {
    patch['internalCandidateId'] = toObjectId(input.internalCandidateId);
  }
  if (!conversation.externalCandidateId && input.externalCandidateId) {
    patch['externalCandidateId'] = toObjectId(input.externalCandidateId);
  }
  if (!conversation.matchSuggestionId && input.matchSuggestionId) {
    patch['matchSuggestionId'] = toObjectId(input.matchSuggestionId);
  }
  if (Object.keys(patch).length === 0) return;

  await Conversation.updateOne(
    { _id: conversation._id },
    { $set: patch },
  ).exec();
}

// ── Explicit re-linking (callers with authoritative data) ──

export async function linkConversationToMatch(
  conversationId: string,
  matchSuggestionId: string,
): Promise<void> {
  if (!Types.ObjectId.isValid(conversationId) || !Types.ObjectId.isValid(matchSuggestionId)) {
    throw new Error('Invalid id(s) provided to linkConversationToMatch');
  }
  await Conversation.updateOne(
    { _id: new Types.ObjectId(conversationId) },
    { $set: { matchSuggestionId: new Types.ObjectId(matchSuggestionId) } },
  ).exec();
}

export async function linkConversationToInternalCandidate(
  conversationId: string,
  internalCandidateId: string,
): Promise<void> {
  if (!Types.ObjectId.isValid(conversationId) || !Types.ObjectId.isValid(internalCandidateId)) {
    throw new Error('Invalid id(s) provided');
  }
  await Conversation.updateOne(
    { _id: new Types.ObjectId(conversationId) },
    { $set: { internalCandidateId: new Types.ObjectId(internalCandidateId) } },
  ).exec();
}

export async function linkConversationToExternalCandidate(
  conversationId: string,
  externalCandidateId: string,
): Promise<void> {
  if (!Types.ObjectId.isValid(conversationId) || !Types.ObjectId.isValid(externalCandidateId)) {
    throw new Error('Invalid id(s) provided');
  }
  await Conversation.updateOne(
    { _id: new Types.ObjectId(conversationId) },
    { $set: { externalCandidateId: new Types.ObjectId(externalCandidateId) } },
  ).exec();
}

// ── Conversation chain (UI traces across account replacement) ──

export async function getConversationChain(
  conversationId: string,
): Promise<IConversation[]> {
  if (!Types.ObjectId.isValid(conversationId)) return [];

  const chain: IConversation[] = [];
  let cursor: Types.ObjectId | undefined = new Types.ObjectId(conversationId);
  const visited = new Set<string>();

  while (cursor && !visited.has(String(cursor))) {
    visited.add(String(cursor));
    const conv = await Conversation.findById(cursor).exec();
    if (!conv) break;
    chain.unshift(conv);
    cursor = conv.supersedesConversationId;
  }

  return chain;
}

// Suppress-lint: Channel import is intentional for type only
export type { IChannel };

// ── Utility ──────────────────────────────────────────────

function toObjectId(id: string | undefined): Types.ObjectId | undefined {
  if (!id) return undefined;
  if (!Types.ObjectId.isValid(id)) return undefined;
  return new Types.ObjectId(id);
}
