// ═══════════════════════════════════════════════════════════
// ShadchanAI — Channel Service
//
// Thin wrapper around the whatsapp/channel.manager — enforces
// admin-only mutations and audits every lifecycle transition.
// Serialization strips secrets (tokenRef) before returning.
// ═══════════════════════════════════════════════════════════

import { AuditActionType, AuditEntityType } from '@shadchanai/shared';
import { Channel, type IChannel } from '../../models/index.js';
import { channels as channelMgr } from '../../services/whatsapp/whatsapp.service.js';
import { audit } from '../../services/audit.service.js';
import { NotFoundError, BusinessRuleError } from '../../utils/errors.js';
import { publishRealtimeEvent } from '../../services/realtime/realtime.service.js';
import { discoverChats, type DiscoveryResult } from '../../services/whatsapp/chat-discovery.service.js';
import { ChatMapping } from '../../models/index.js';
import { Types } from 'mongoose';
import { ChannelStatus } from '@shadchanai/shared';
import { toSkipLimit, buildSort, makeMeta } from '../../utils/pagination.js';
import type { ListChannelsQuery } from './channel.validator.js';
import type { ConnectChannelInput } from '../../services/whatsapp/whatsapp.types.js';

/** Public, secret-stripped channel shape */
export interface ChannelView {
  channelId: string;
  role: string;
  accountDisplayName: string;
  phoneNumber: string;
  provider: string;
  providerSessionId?: string;
  status: string;
  connectionHealth: string;
  webhookStatus: string;
  lastConnectedAt?: Date;
  lastInboundAt?: Date;
  lastOutboundAt?: Date;
  replacesChannelId?: string;
  replacedByChannelId?: string;
  statusReason?: string;
  lastDisconnectAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export function toChannelView(doc: IChannel): ChannelView {
  return {
    channelId: doc.channelId,
    role: doc.role,
    accountDisplayName: doc.accountDisplayName,
    phoneNumber: doc.phoneNumber,
    provider: doc.provider,
    providerSessionId: doc.providerSessionId,
    status: doc.status,
    connectionHealth: doc.connectionHealth,
    webhookStatus: doc.webhookStatus,
    lastConnectedAt: doc.lastConnectedAt,
    lastInboundAt: doc.lastInboundAt,
    lastOutboundAt: doc.lastOutboundAt,
    replacesChannelId: doc.replacesChannelId,
    replacedByChannelId: doc.replacedByChannelId,
    statusReason: doc.statusReason,
    lastDisconnectAt: doc.lastDisconnectAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function listChannels(
  query: ListChannelsQuery,
): Promise<{ items: ChannelView[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  const { skip, limit } = toSkipLimit(query);
  const sort = buildSort(query, 'createdAt');

  const filter: Record<string, unknown> = {};
  if (query.role) filter['role'] = query.role;
  if (query.status) filter['status'] = query.status;

  const [docs, total] = await Promise.all([
    Channel.find(filter).sort(sort).skip(skip).limit(limit).exec(),
    Channel.countDocuments(filter).exec(),
  ]);

  return {
    items: docs.map(toChannelView),
    total,
    meta: makeMeta(query.page, query.limit, total),
  };
}

export async function getChannel(channelId: string): Promise<ChannelView> {
  const doc = await channelMgr.findById(channelId);
  if (!doc) throw new NotFoundError('Channel', channelId);
  return toChannelView(doc);
}

export async function connect(
  input: ConnectChannelInput,
  performedBy: string,
): Promise<ChannelView> {
  const doc = await channelMgr.connect(input);
  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(doc._id),
    actionType: AuditActionType.CREATE,
    performedBy,
    after: toChannelView(doc),
  });
  return toChannelView(doc);
}

export async function reconnect(channelId: string, performedBy: string): Promise<ChannelView> {
  const before = await channelMgr.findById(channelId);
  const doc = await channelMgr.reconnect(channelId);
  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(doc._id),
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before: before ? toChannelView(before) : undefined,
    after: toChannelView(doc),
    metadata: { transition: 'reconnect' },
  });
  publishRealtimeEvent('channel.updated', {
    channelId: doc.channelId,
    status: doc.status,
    connectionHealth: doc.connectionHealth,
    transition: 'reconnect',
  });
  return toChannelView(doc);
}

export async function disconnect(
  channelId: string,
  reason: string | undefined,
  performedBy: string,
): Promise<ChannelView> {
  const before = await channelMgr.findById(channelId);
  const doc = await channelMgr.disconnect(channelId, reason);
  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(doc._id),
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before: before ? toChannelView(before) : undefined,
    after: toChannelView(doc),
    metadata: { transition: 'disconnect', reason },
  });
  publishRealtimeEvent('channel.updated', {
    channelId: doc.channelId,
    status: doc.status,
    connectionHealth: doc.connectionHealth,
    transition: 'disconnect',
  });
  return toChannelView(doc);
}

export async function replace(
  oldChannelId: string,
  newChannel: ConnectChannelInput,
  performedBy: string,
): Promise<{ oldChannel: ChannelView; newChannel: ChannelView }> {
  const result = await channelMgr.replace({ oldChannelId, newChannel });
  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(result.newChannel._id),
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before: toChannelView(result.oldChannel),
    after: toChannelView(result.newChannel),
    metadata: { transition: 'replace', oldChannelId, newChannelId: result.newChannel.channelId },
  });
  publishRealtimeEvent('channel.updated', {
    channelId: result.newChannel.channelId,
    status: result.newChannel.status,
    connectionHealth: result.newChannel.connectionHealth,
    transition: 'replace',
    replacesChannelId: result.oldChannel.channelId,
  });
  return {
    oldChannel: toChannelView(result.oldChannel),
    newChannel: toChannelView(result.newChannel),
  };
}

export async function chain(channelId: string): Promise<string[]> {
  return channelMgr.chain(channelId);
}

export async function healthSummary(): Promise<Array<{
  channelId: string;
  role: string;
  status: string;
  connectionHealth: string;
  webhookStatus: string;
  lastInboundAt?: Date;
  lastOutboundAt?: Date;
}>> {
  const docs = await Channel.find({}).exec();
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

// ═══════════════════════════════════════════════════════════
// Baileys session administration
//
// Separate from the CRUD lifecycle above because these operate
// on the in-process Baileys client, not on DB state alone.
// ═══════════════════════════════════════════════════════════

import {
  startChannelClient,
  stopChannelClient,
  logoutChannelClient,
  getChannelClient,
} from '../../services/whatsapp/providers/baileys/baileys.client.js';
import type { BaileysChannelStatus } from '../../services/whatsapp/whatsapp.types.js';

// In-memory lock to prevent two operators (or two tabs) from
// concurrently initiating a pairing on the same channel. Single-
// instance only — Phase 7 hardening explicitly accepts this.
const sessionStartLocks = new Set<string>();

/** Start (or restart) the Baileys session for a channel. */
export async function startSession(channelId: string, performedBy: string): Promise<BaileysChannelStatus> {
  const channel = await channelMgr.findById(channelId);
  if (!channel) throw new NotFoundError('Channel', channelId);

  if (sessionStartLocks.has(channel.channelId)) {
    throw new BusinessRuleError(
      'A session-start is already in progress for this channel. Please wait a few seconds and refresh status.',
      { code: 'session_start_in_progress', channelId: channel.channelId },
    );
  }
  sessionStartLocks.add(channel.channelId);
  try {
    const client = await startChannelClient(channel);

    await audit({
      entityType: AuditEntityType.CHANNEL,
      entityId: String(channel._id),
      actionType: AuditActionType.STATUS_CHANGE,
      performedBy,
      metadata: { transition: 'baileys_session_start' },
    });

    // Publish so connected UIs can refresh channel state without
    // manual polling. See realtime.service: 'channel.updated'.
    publishRealtimeEvent('channel.updated', {
      channelId: channel.channelId,
      state: client.status.state,
      connectionHealth: channel.connectionHealth,
      transition: 'session_start',
    });

    return client.status;
  } finally {
    sessionStartLocks.delete(channel.channelId);
  }
}

/** Return current Baileys session status — including the QR when pending_pairing.
 *  The QR is NEVER logged. */
export function sessionStatus(channelId: string): BaileysChannelStatus | null {
  const client = getChannelClient(channelId);
  return client ? client.status : null;
}

/** Stop the Baileys session WITHOUT purging credentials.
 *  Channel remains recoverable via startSession. */
export async function stopSession(channelId: string, performedBy: string): Promise<void> {
  await stopChannelClient(channelId);
  const ch = await channelMgr.findById(channelId);
  if (!ch) return;
  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(ch._id),
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    metadata: { transition: 'baileys_session_stop' },
  });
}

/** Explicit logout: tear down the socket AND purge credentials. */
export async function logoutSession(channelId: string, performedBy: string): Promise<void> {
  await logoutChannelClient(channelId);
  const ch = await channelMgr.findById(channelId);
  if (!ch) return;
  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(ch._id),
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    metadata: { transition: 'baileys_session_logout' },
  });
  publishRealtimeEvent('channel.updated', {
    channelId: ch.channelId,
    status: ch.status,
    transition: 'logout',
  });
}

// ── Pre-pilot discovery & mapping ────────────────────────

export async function listDiscoveredChats(channelId: string): Promise<DiscoveryResult> {
  const ch = await channelMgr.findById(channelId);
  if (!ch) throw new NotFoundError('Channel', channelId);
  return discoverChats(channelId);
}

export async function assignChatRole(
  channelId: string,
  chatJid: string,
  chatType: 'group' | 'private',
  role: 'profiles_source' | 'match_sending' | 'ignore' | null,
  performedBy: string,
  chatName?: string,
): Promise<{ channelId: string; chatJid: string; role: typeof role }> {
  const ch = await channelMgr.findById(channelId);
  if (!ch) throw new NotFoundError('Channel', channelId);

  if (role === null) {
    await ChatMapping.deleteOne({ channelId, chatJid }).exec();
    await audit({
      entityType: AuditEntityType.CHANNEL,
      entityId: String(ch._id),
      actionType: AuditActionType.UPDATE,
      performedBy,
      metadata: { scope: 'chat_mapping_cleared', chatJid, chatType },
    });
    return { channelId, chatJid, role: null };
  }

  await ChatMapping.findOneAndUpdate(
    { channelId, chatJid },
    {
      $set: {
        channelId,
        chatJid,
        chatType,
        chatName,
        role,
        mappedBy: new Types.ObjectId(performedBy),
        mappedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  ).exec();

  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(ch._id),
    actionType: AuditActionType.UPDATE,
    performedBy,
    metadata: { scope: 'chat_mapping_assigned', chatJid, chatType, role },
  });

  return { channelId, chatJid, role };
}

// ── Safe channel deletion ────────────────────────────────
// Only allowed when the channel is already disconnected / suspended /
// replaced AND no live Baileys client is running. Wipes the Channel
// row + its ChatMappings; conversation history is retained because
// Conversation rows reference channelId but don't cascade-delete.

export async function deleteChannelSafely(channelId: string, performedBy: string): Promise<void> {
  const ch = await channelMgr.findById(channelId);
  if (!ch) throw new NotFoundError('Channel', channelId);

  const safeStatuses: string[] = [
    ChannelStatus.DISCONNECTED,
    ChannelStatus.SUSPENDED,
    ChannelStatus.REPLACED,
  ];
  if (!safeStatuses.includes(ch.status)) {
    throw new BusinessRuleError(
      `Cannot delete channel in status '${ch.status}'. Disconnect or logout first.`,
      { code: 'channel_not_safe_to_delete', status: ch.status },
    );
  }

  // Defensive: if a Baileys client is still registered in memory for
  // this id, refuse — logout/stop should have been called first.
  const { getChannelClient } = await import('../../services/whatsapp/providers/baileys/baileys.client.js');
  if (getChannelClient(channelId)) {
    throw new BusinessRuleError(
      'A live Baileys session is still running. Logout or stop it before deleting.',
      { code: 'session_still_running' },
    );
  }

  await ChatMapping.deleteMany({ channelId }).exec();
  await Channel.deleteOne({ channelId }).exec();

  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(ch._id),
    actionType: AuditActionType.DELETE,
    performedBy,
    metadata: { transition: 'delete', formerStatus: ch.status },
  });
  publishRealtimeEvent('channel.updated', {
    channelId: ch.channelId,
    status: 'deleted',
    transition: 'delete',
  });
}
