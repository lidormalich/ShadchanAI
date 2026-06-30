// ═══════════════════════════════════════════════════════════
// ShadchanAI — Channel Manager
//
// Manages WhatsApp channel lifecycle:
//   - connect      → create a new channel (ACTIVE)
//   - reconnect    → bring an existing channel back online
//   - disconnect   → mark a channel DISCONNECTED (no sends/receives)
//   - replace      → create a new channel, mark old as REPLACED,
//                    set replacement-chain metadata, PRESERVE HISTORY
//   - findByPhoneNumberId → webhook routing
//   - findByChannelId     → internal lookup
//
// Critical invariants:
//   - Channels are split by ROLE (profiles_source / match_sending),
//     NEVER by religious sector.
//   - Replacement never deletes or merges history. Old channel stays
//     intact; new channel has its own id and optionally a pointer back.
// ═══════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { ChannelStatus, ChannelProvider, WebhookStatus } from '@shadchanai/shared';
import { Channel, type IChannel } from '../../models/index.js';
import type {
  ConnectChannelInput,
  ReplaceChannelInput,
  ChannelHealthUpdate,
  ChannelStatusPatch,
} from './whatsapp.types.js';
import { logWhatsApp } from './whatsapp.logger.js';
import {
  getChannelClient,
  startChannelClient,
  setChannelStatusPersister,
} from './providers/baileys/baileys.client.js';

// ── Transport → domain status persistence ────────────────
//
// The Baileys transport detects connection/status transitions but
// must not write to the Channel model itself. It emits status patches
// through this persister, which is the single place that owns the
// Channel.updateOne for transport-driven status changes. Routing is
// always by channelId — never raw phone.

export async function persistChannelStatus(
  channelId: string,
  patch: ChannelStatusPatch,
): Promise<void> {
  await Channel.updateOne({ channelId }, { $set: patch }).exec();
}

// Wire the seam at module load so any client created via
// startChannelClient (boot or operator-initiated) persists through
// the domain layer.
setChannelStatusPersister(persistChannelStatus);

// ── Utilities ────────────────────────────────────────────

function newChannelId(): string {
  return `ch_${crypto.randomBytes(8).toString('hex')}`;
}

// ── Lookups ──────────────────────────────────────────────

export async function findChannelById(channelId: string): Promise<IChannel | null> {
  return Channel.findOne({ channelId }).exec();
}

/**
 * Find the active channel by internal provider session id.
 * For Baileys, session id == channelId by default. Returns null
 * if no match — callers treat that as "ignore this event with a warning".
 */
export async function findChannelByProviderSessionId(
  providerSessionId: string,
): Promise<IChannel | null> {
  return Channel.findOne({
    providerSessionId,
    status: { $in: [ChannelStatus.ACTIVE, ChannelStatus.RATE_LIMITED] },
  }).exec();
}

/** Back-compat alias used by older call sites (message.handler). */
export const findChannelByPhoneNumberId = findChannelByProviderSessionId;

export async function findActiveChannelByRole(role: string): Promise<IChannel | null> {
  return Channel.findOne({ role, status: ChannelStatus.ACTIVE }).exec();
}

// ── Connect ──────────────────────────────────────────────

export async function connectChannel(input: ConnectChannelInput): Promise<IChannel> {
  const channelId = newChannelId();
  const channel = await Channel.create({
    channelId,
    role: input.channelRole,
    accountDisplayName: input.accountDisplayName,
    phoneNumber: input.phoneNumber ?? '', // filled after Baileys pairing
    provider: ChannelProvider.WHATSAPP_CLOUD,
    // Default provider session id = channelId. Baileys session files are
    // stored under <WA_SESSIONS_DIR>/<channelId>/.
    providerSessionId: input.providerSessionId ?? channelId,
    status: ChannelStatus.ACTIVE,
    connectionHealth: 'degraded', // becomes 'healthy' once Baileys connection opens
    webhookStatus: WebhookStatus.PENDING, // repurposed under Baileys: 'verified' once session auth succeeds
    replacesChannelId: input.replacesChannelId,
  });

  logWhatsApp({
    event: 'channel_connected',
    channelId: channel.channelId,
    channelRole: channel.role,
    accountDisplayName: channel.accountDisplayName,
  });

  return channel;
}

// ── Reconnect ────────────────────────────────────────────

export async function reconnectChannel(channelId: string): Promise<IChannel> {
  const channel = await Channel.findOneAndUpdate(
    { channelId },
    {
      $set: {
        status: ChannelStatus.ACTIVE,
        connectionHealth: 'healthy',
        lastConnectedAt: new Date(),
      },
    },
    { new: true },
  ).exec();

  if (!channel) throw new Error(`Channel not found: ${channelId}`);

  const client = getChannelClient(channelId);
  if (client) {
    client.resetCircuit();
    await client.start();
  } else {
    await startChannelClient(channel);
  }

  logWhatsApp({
    event: 'channel_reconnected',
    channelId: channel.channelId,
    channelRole: channel.role,
  });

  return channel;
}

// ── Intentional disconnect ───────────────────────────────

export async function disconnectChannel(
  channelId: string,
  options: { reason?: string } = {},
): Promise<IChannel> {
  const channel = await Channel.findOneAndUpdate(
    { channelId },
    {
      $set: {
        status: ChannelStatus.DISCONNECTED,
        connectionHealth: 'down',
      },
    },
    { new: true },
  ).exec();

  if (!channel) throw new Error(`Channel not found: ${channelId}`);

  logWhatsApp({
    event: 'channel_disconnected',
    channelId: channel.channelId,
    channelRole: channel.role,
    reason: options.reason,
  });

  return channel;
}

// ── Replace account (PRESERVE HISTORY) ───────────────────
//
// Creates a new channel, marks the old channel REPLACED, sets
// replacement-chain pointers in both directions. Old messages,
// conversations, and history stay on the old channelId — they are
// NEVER copied, migrated, or deleted.
//
// Continuity across accounts is surfaced via Conversation's
// supersedesConversationId / replacedChannelOriginId fields —
// those are populated when a new inbound message arrives on the
// new channel from a participant the old channel knew.

export async function replaceChannel(
  input: ReplaceChannelInput,
): Promise<{ oldChannel: IChannel; newChannel: IChannel }> {
  const oldChannel = await Channel.findOne({ channelId: input.oldChannelId }).exec();
  if (!oldChannel) throw new Error(`Old channel not found: ${input.oldChannelId}`);

  // 1. Create the new channel first (ACTIVE)
  const newChannel = await connectChannel({
    ...input.newChannel,
    replacesChannelId: oldChannel.channelId,
  });

  // 2. Mark old channel REPLACED, pointing at the new one
  oldChannel.status = ChannelStatus.REPLACED;
  oldChannel.connectionHealth = 'down';
  oldChannel.replacedByChannelId = newChannel.channelId;
  await oldChannel.save();

  logWhatsApp({
    event: 'channel_replaced',
    channelId: newChannel.channelId,
    channelRole: newChannel.role,
    accountDisplayName: newChannel.accountDisplayName,
    replacedChannelId: oldChannel.channelId,
  });

  return { oldChannel, newChannel };
}

// ── Mark inactive (same as disconnect but without intent) ─

export async function markChannelInactive(
  channelId: string,
  reason: 'rate_limited' | 'suspended',
): Promise<IChannel> {
  const status = reason === 'rate_limited' ? ChannelStatus.RATE_LIMITED : ChannelStatus.SUSPENDED;
  const channel = await Channel.findOneAndUpdate(
    { channelId },
    { $set: { status, connectionHealth: 'degraded' } },
    { new: true },
  ).exec();

  if (!channel) throw new Error(`Channel not found: ${channelId}`);

  logWhatsApp({
    event: 'channel_disconnected',
    channelId: channel.channelId,
    channelRole: channel.role,
    reason,
  });

  return channel;
}

// ── Health updates ───────────────────────────────────────

export async function updateChannelHealth(update: ChannelHealthUpdate): Promise<void> {
  const set: Record<string, unknown> = {
    connectionHealth: update.connectionHealth,
    lastHealthCheckAt: update.lastHealthCheckAt ?? new Date(),
  };
  if (update.webhookStatus) set['webhookStatus'] = update.webhookStatus;
  await Channel.updateOne({ channelId: update.channelId }, { $set: set }).exec();
}

/** Bump `lastInboundAt` / `lastOutboundAt` after message processing. */
export async function touchChannelActivity(
  channelId: string,
  direction: 'inbound' | 'outbound',
): Promise<void> {
  const field = direction === 'inbound' ? 'lastInboundAt' : 'lastOutboundAt';
  await Channel.updateOne(
    { channelId },
    { $set: { [field]: new Date() } },
  ).exec();
}

// ── Chain walk (for UI continuity) ───────────────────────

/**
 * Walk the replacement chain from this channel backward until we
 * reach a channel with no `replacesChannelId`. Returns channel IDs
 * in chronological order (oldest → newest).
 */
export async function getChannelChain(channelId: string): Promise<string[]> {
  const chain: string[] = [];
  let cursor: string | undefined = channelId;
  const visited = new Set<string>();

  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    chain.unshift(cursor);
    const ch = await Channel.findOne({ channelId: cursor })
      .select('replacesChannelId')
      .lean()
      .exec();
    cursor = ch?.replacesChannelId;
  }

  return chain;
}

// ── Helpers for tests / callers needing ObjectId validation ──

export function isValidObjectId(id: unknown): boolean {
  return typeof id === 'string' && Types.ObjectId.isValid(id);
}
