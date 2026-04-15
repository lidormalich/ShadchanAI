// ═══════════════════════════════════════════════════════════
// ShadchanAI — WhatsApp Service (Public Facade)
//
// Unified surface for channel lifecycle, message lookup, and
// (future) outbound sending. Does NOT send messages yet — the
// send path requires the proposal-sending integration planned
// for a later step. This file scaffolds that surface now so
// routers and services have a stable place to call.
//
// GUARDRAILS:
//   - AI never calls this file directly — only the tools layer
//     or explicit user-initiated Shadchan actions do.
//   - Every outbound send (once implemented) must be initiated by
//     a human-approved action, never by AI inference.
// ═══════════════════════════════════════════════════════════

import { ChannelRole, ChannelStatus } from '@shadchanai/shared';
import type { IChannel } from '../../models/index.js';
import { Message, Conversation } from '../../models/index.js';
import {
  connectChannel,
  reconnectChannel,
  disconnectChannel,
  replaceChannel,
  findChannelById,
  findActiveChannelByRole,
  getChannelChain,
  updateChannelHealth,
} from './channel.manager.js';
import { getConversationChain } from './conversation.linker.js';
import type {
  ConnectChannelInput,
  ReplaceChannelInput,
} from './whatsapp.types.js';

// ── Channel lifecycle facade ─────────────────────────────

export const channels = {
  connect: (input: ConnectChannelInput): Promise<IChannel> => connectChannel(input),
  reconnect: (channelId: string): Promise<IChannel> => reconnectChannel(channelId),
  disconnect: (channelId: string, reason?: string): Promise<IChannel> =>
    disconnectChannel(channelId, { reason }),
  replace: (input: ReplaceChannelInput) => replaceChannel(input),
  findById: (channelId: string): Promise<IChannel | null> => findChannelById(channelId),
  findActiveByRole: (role: ChannelRole): Promise<IChannel | null> =>
    findActiveChannelByRole(role),
  chain: (channelId: string): Promise<string[]> => getChannelChain(channelId),
  updateHealth: updateChannelHealth,
};

// ── Conversation/message lookups ─────────────────────────

export const conversations = {
  chain: getConversationChain,
  listForChannel: async (
    channelId: string,
    limit = 50,
  ): Promise<Array<{ id: string; participantName?: string; lastMessageAt?: Date; unreadCount: number }>> => {
    const docs = await Conversation.find({ channelId })
      .sort({ lastMessageAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return docs.map((d) => ({
      id: String(d._id),
      participantName: d.participantName,
      lastMessageAt: d.lastMessageAt,
      unreadCount: d.unreadCount,
    }));
  },
};

export const messages = {
  listForConversation: async (
    conversationId: string,
    limit = 100,
  ): Promise<Array<{
    id: string;
    direction: string;
    contentType: string;
    body?: string;
    deliveryStatus: string;
    createdAt: Date;
  }>> => {
    const docs = await Message.find({ conversationId })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean()
      .exec();
    return docs.map((d) => ({
      id: String(d._id),
      direction: d.direction,
      contentType: d.contentType,
      body: d.body,
      deliveryStatus: d.deliveryStatus,
      createdAt: d.createdAt,
    }));
  },
};

// ── Send text via Baileys ────────────────────────────────
//
// The LOW-LEVEL provider-send path. Callers (match.service /
// conversation.service) must have already:
//   - verified role permissions
//   - verified send-preview canSend (for match proposals)
//   - written a pre-flight audit entry
//
// This wrapper enforces ONLY the provider-boundary invariants:
//   - channel exists
//   - channel.role === 'match_sending' (sends are NEVER on profiles_source)
//   - channel.status === 'active' (not disconnected/replaced/suspended)
//   - Baileys client is loaded and connected
//
// Returns the WhatsApp-assigned externalMessageId on success.

import { BusinessRuleError } from '../../utils/errors.js';
import { getChannelClient } from './providers/baileys/baileys.client.js';

export interface SendTextRequest {
  channelId: string;
  jid: string;
  body: string;
}

export async function sendTextFromChannel(req: SendTextRequest): Promise<string> {
  const channel = await findChannelById(req.channelId);
  if (!channel) throw new BusinessRuleError('Channel not found', { code: 'channel_not_found' });

  if (channel.role !== ChannelRole.MATCH_SENDING) {
    throw new BusinessRuleError(
      'Outbound sends are only allowed on a match_sending channel',
      { code: 'wrong_channel_role', role: channel.role },
    );
  }

  if (channel.status !== ChannelStatus.ACTIVE) {
    throw new BusinessRuleError(
      `Channel is not active (status=${channel.status})`,
      { code: 'channel_not_active', status: channel.status },
    );
  }

  if (channel.connectionHealth !== 'healthy') {
    throw new BusinessRuleError(
      `Channel connection is not healthy (connectionHealth=${channel.connectionHealth})`,
      { code: 'channel_unhealthy', connectionHealth: channel.connectionHealth },
    );
  }

  const client = getChannelClient(channel.channelId);
  if (!client) {
    throw new BusinessRuleError(
      'No Baileys session is running for this channel — start the session first',
      { code: 'session_not_running' },
    );
  }

  if (client.status.state !== 'connected') {
    throw new BusinessRuleError(
      `Baileys session is not connected (state=${client.status.state})`,
      { code: 'session_not_connected', state: client.status.state },
    );
  }

  // Delegate to the client — which enforces its own socket-level check.
  // Errors from the socket bubble up to the caller, which wraps them in
  // the correct audit + Message-row failure path.
  return client.sendText(req.jid, req.body);
}

/** Resolve a participant phone into a Baileys JID.
 *  Strips any non-digit characters and appends the WhatsApp individual suffix.
 *  Groups are NOT supported for outbound in this feature. */
export function phoneToJid(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) {
    throw new BusinessRuleError('Invalid destination phone', { code: 'invalid_destination_phone' });
  }
  return `${digits}@s.whatsapp.net`;
}

// ── Health check utility for ops/admin endpoints ─────────

export interface ChannelHealthSummary {
  channelId: string;
  role: ChannelRole;
  status: ChannelStatus;
  connectionHealth: string;
  webhookStatus: string;
  lastInboundAt?: Date;
  lastOutboundAt?: Date;
}

export async function channelHealthSummary(): Promise<ChannelHealthSummary[]> {
  const { Channel } = await import('../../models/index.js');
  const docs = await Channel.find({}).lean().exec();
  return docs.map((d) => ({
    channelId: d.channelId,
    role: d.role,
    status: d.status,
    connectionHealth: d.connectionHealth,
    webhookStatus: d.webhookStatus,
    lastInboundAt: d.lastInboundAt,
    lastOutboundAt: d.lastOutboundAt,
  }));
}
