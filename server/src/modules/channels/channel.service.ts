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
import { NotFoundError } from '../../utils/errors.js';
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

/** Start (or restart) the Baileys session for a channel. */
export async function startSession(channelId: string, performedBy: string): Promise<BaileysChannelStatus> {
  const channel = await channelMgr.findById(channelId);
  if (!channel) throw new NotFoundError('Channel', channelId);

  const client = await startChannelClient(channel);

  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(channel._id),
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    metadata: { transition: 'baileys_session_start' },
  });

  return client.status;
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
}
