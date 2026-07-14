// ═══════════════════════════════════════════════════════════
// ShadchanAI — Channel Service
//
// Thin wrapper around the whatsapp/channel.manager — enforces
// admin-only mutations and audits every lifecycle transition.
// Serialization strips secrets (tokenRef) before returning.
// ═══════════════════════════════════════════════════════════

import { AuditActionType, AuditEntityType, MessageDirection, MessageIngestionDecision } from '@shadchanai/shared';
import { Channel, type IChannel } from '../../models/index.js';
import { channels as channelMgr } from '../../services/whatsapp/whatsapp.service.js';
import { audit } from '../../services/audit.service.js';
import { NotFoundError, BusinessRuleError } from '../../utils/errors.js';
import { publishRealtimeEvent } from '../../services/realtime/realtime.service.js';
import { discoverChats, type DiscoveryResult } from '../../services/whatsapp/chat-discovery.service.js';
import { ChatMapping, Conversation, Message, CoverageReport, type ICoverageChatEntry } from '../../models/index.js';
import { enqueueExtraction } from '../../services/extraction/queue.js';
import { Types } from 'mongoose';
import { ChannelStatus } from '@shadchanai/shared';
import { toSkipLimit, buildSort, makeMeta } from '../../utils/pagination.js';
import type { ListChannelsQuery, CoverageReportsQuery } from './channel.validator.js';
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
  lastAutoReconnectAt?: Date;
  autoReconnectCount?: number;
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
    lastAutoReconnectAt: doc.lastAutoReconnectAt,
    autoReconnectCount: doc.autoReconnectCount,
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
  // Tear down the live socket FIRST. Otherwise an orphaned Baileys connection
  // keeps emitting inbound messages.upsert events into a channel we've flipped
  // to DISCONNECTED, and the status-gated handler lookup silently drops them.
  await stopChannelClient(channelId);
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
  describeAllSessions,
} from '../../services/whatsapp/providers/baileys/baileys.client.js';
import type { BaileysChannelStatus } from '../../services/whatsapp/whatsapp.types.js';
import {
  forceReleaseChannelLock,
  inspectChannelLock,
  INSTANCE_ID,
  type LockInfo,
} from '../../services/whatsapp/instance.lock.js';

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

// Pending chats = every chat that hasn't been assigned a role yet (the
// "ערוצים בהמתנה" triage surface). Chats that already have held-back
// messages waiting for a decision are surfaced first so the real work is
// on top; brand-new chats with nothing waiting still appear so the
// operator can proactively choose which to pull from.
export async function listPendingChats(channelId: string): Promise<DiscoveryResult> {
  const ch = await channelMgr.findById(channelId);
  if (!ch) throw new NotFoundError('Channel', channelId);
  const result = await discoverChats(channelId);
  const chats = result.chats
    .filter((c) => !c.role)
    .sort((a, b) => {
      // Waiting messages first (most-waiting on top), then recent activity.
      const ap = a.pendingMessageCount ?? 0;
      const bp = b.pendingMessageCount ?? 0;
      if (ap !== bp) return bp - ap;
      const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      if (at !== bt) return bt - at;
      // Stable tiebreaker so rows don't reshuffle between 30s refetches.
      return a.chatJid.localeCompare(b.chatJid);
    });
  return { ...result, chats };
}

export async function assignChatRole(
  channelId: string,
  chatJid: string,
  chatType: 'group' | 'private',
  role: 'profiles_source' | 'match_sending' | 'ignore' | null,
  performedBy: string,
  chatName?: string,
  backfillExisting?: boolean,
): Promise<{ channelId: string; chatJid: string; role: typeof role; backfilled?: number }> {
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

  // When the operator approves a previously-unmapped chat as a profiles
  // source and opts in, retroactively feed everything that already
  // arrived from it (held back as ignored_unmapped) into extraction.
  let backfilled: number | undefined;
  if (role === 'profiles_source' && backfillExisting) {
    backfilled = await backfillChatExtraction(channelId, chatJid, performedBy);
  }

  return { channelId, chatJid, role, backfilled };
}

// ── Retroactive backfill of held-back (pending) messages ────
//
// Takes every inbound message that the ingestion gate stored but held
// back for this chat (ingestion.decision = ignored_unmapped) and feeds
// it into the extraction pipeline — flipping the decision to ACCEPTED so
// the audit trail reflects the operator's approval and the message is no
// longer counted as pending. Used when a pending chat is approved as a
// profiles source, and by the explicit per-chat backfill endpoint.
//
// Message stores conversationId (not chatJid), so we resolve the chat's
// conversations first (a group has one conversation per sender, all
// sharing the chatJid) and then scan their messages.
export async function backfillChatExtraction(
  channelId: string,
  chatJid: string,
  performedBy: string,
): Promise<number> {
  const conversations = await Conversation.find({ channelId, chatJid })
    .select('_id')
    .lean()
    .exec();
  if (conversations.length === 0) return 0;

  const conversationIds = conversations.map((c) => c._id);
  const messages = await Message.find({
    conversationId: { $in: conversationIds },
    direction: MessageDirection.INBOUND,
    'ingestion.decision': MessageIngestionDecision.IGNORED_UNMAPPED,
  })
    .select('_id')
    .lean()
    .exec();

  let enqueued = 0;
  for (const m of messages) {
    // Flip the verdict so it stops counting as pending and the audit
    // trail shows it was accepted on approval, then enqueue extraction.
    await Message.updateOne(
      { _id: m._id },
      {
        $set: {
          ingestion: {
            decision: MessageIngestionDecision.ACCEPTED,
            effectiveRole: 'profiles_source',
            decidedAt: new Date(),
          },
        },
      },
    ).exec();
    void enqueueExtraction(String(m._id)).catch(() => undefined);
    enqueued += 1;
  }

  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: channelId,
    actionType: AuditActionType.UPDATE,
    performedBy,
    metadata: { scope: 'chat_backfill_extraction', chatJid, enqueued },
  });

  return enqueued;
}

// ── Preview a pending chat's stored messages ────────────────
//
// Returns the most recent inbound messages we've already stored for a
// chat, newest first — so the operator can read what's actually in the
// group before deciding to approve/ignore it. The group's *name* is
// often wrong or missing (a group's participantName is a sender's
// pushName, not the subject), so the message bodies are the reliable
// signal for "what is this chat".
//
// Message carries a denormalized chatJid, so we can read straight by
// (channelId, chatJid) without resolving conversations. Not gated on
// ingestion.decision — an unmapped chat's messages are all held back
// anyway, and once approved the operator may still want to look back.
export interface ChatMessagePreview {
  id: string;
  senderName?: string;
  senderPhone?: string;
  direction: string;
  contentType: string;
  body?: string;
  mediaCaption?: string;
  mediaMimeType?: string;
  createdAt: string;
}

export async function listChatMessages(
  channelId: string,
  chatJid: string,
  limit = 50,
): Promise<{ channelId: string; chatJid: string; messages: ChatMessagePreview[] }> {
  const ch = await channelMgr.findById(channelId);
  if (!ch) throw new NotFoundError('Channel', channelId);

  const capped = Math.min(Math.max(limit, 1), 200);
  const rows = await Message.find({ channelId, chatJid })
    .select('senderName senderPhone direction contentType body mediaCaption mediaMimeType createdAt')
    .sort({ createdAt: -1 })
    .limit(capped)
    .lean()
    .exec();

  // Newest-first for the query (so a capped read keeps the latest), then
  // flip to chronological for reading top-to-bottom like a chat thread.
  const messages: ChatMessagePreview[] = rows
    .reverse()
    .map((m) => ({
      id: String(m._id),
      senderName: m.senderName,
      senderPhone: m.senderPhone,
      direction: m.direction,
      contentType: m.contentType,
      body: m.body,
      mediaCaption: m.mediaCaption,
      mediaMimeType: m.mediaMimeType,
      createdAt: m.createdAt.toISOString(),
    }));

  return { channelId, chatJid, messages };
}

// ── Best-effort WhatsApp history pull for a chat ────────────
//
// Asks the live Baileys session to fetch older history for this chat.
// Whatever WhatsApp delivers flows back through the normal inbound path
// (messaging-history.set → ingest), so it lands subject to the same
// ingestion gate: an unmapped chat accumulates as pending, a mapped
// profiles_source chat extracts immediately. Best-effort — WhatsApp
// does not always return the full history, and nothing arrives if the
// session isn't connected.
export async function requestChatHistorySync(
  channelId: string,
  chatJid: string,
  performedBy: string,
): Promise<{ requested: boolean; reason?: string }> {
  const ch = await channelMgr.findById(channelId);
  if (!ch) throw new NotFoundError('Channel', channelId);

  const { getChannelClient } = await import(
    '../../services/whatsapp/providers/baileys/baileys.client.js'
  );
  const client = getChannelClient(channelId);
  if (!client || client.status.state !== 'connected') {
    return { requested: false, reason: 'session_not_connected' };
  }

  const result = await client.requestHistorySync(chatJid);

  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(ch._id),
    actionType: AuditActionType.UPDATE,
    performedBy,
    metadata: { scope: 'chat_history_sync', chatJid, requested: result.requested },
  });

  return result;
}

// ── Safe channel deletion ────────────────────────────────
// Only allowed when the channel is already disconnected / suspended /
// replaced AND no live Baileys client is running.
//
// History is NEVER silently orphaned: a channel that still holds
// Conversation/Message history cannot be deleted unless the caller
// says where that history should go —
//   • reassignHistoryTo: an explicit live channel to re-home onto, OR
//   • the channel's replacedByChannelId (auto-used when set), OR
//   • orphanHistory: true — an explicit acknowledgement to leave it.
// Without one of these we throw, because a plain delete used to strand
// the history under a dead channelId (invisible to discovery).

export interface DeleteChannelOptions {
  reassignHistoryTo?: string;
  orphanHistory?: boolean;
}

export async function deleteChannelSafely(
  channelId: string,
  performedBy: string,
  opts: DeleteChannelOptions = {},
): Promise<void> {
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

  // Guard the history: never let a delete strand conversations/messages.
  const convCount = await Conversation.countDocuments({ channelId }).exec();
  const reassignTarget = opts.reassignHistoryTo ?? ch.replacedByChannelId ?? undefined;
  let historyReassignedTo: string | undefined;
  if (convCount > 0) {
    if (reassignTarget) {
      const target = await Channel.findOne({ channelId: reassignTarget }).select('channelId').lean().exec();
      if (!target) {
        throw new BusinessRuleError(
          `Reassign target channel '${reassignTarget}' does not exist.`,
          { code: 'reassign_target_missing', reassignTarget },
        );
      }
      await Conversation.updateMany(
        { channelId },
        { $set: { channelId: reassignTarget, migratedFromChannelId: channelId } },
      ).exec();
      await Message.updateMany(
        { channelId },
        { $set: { channelId: reassignTarget, migratedFromChannelId: channelId } },
      ).exec();
      // Never-gated inbound messages (no ingestion.decision) would stay
      // invisible to discovery/pending after the move. Normalize them to
      // ignored_unmapped — same as the rehome-orphaned-channels recovery —
      // so the reassigned history surfaces as pending and is backfillable.
      await Message.updateMany(
        { channelId: reassignTarget, migratedFromChannelId: channelId, direction: MessageDirection.INBOUND, 'ingestion.decision': { $exists: false } },
        { $set: { ingestion: { decision: MessageIngestionDecision.IGNORED_UNMAPPED, decidedAt: new Date() } } },
      ).exec();
      historyReassignedTo = reassignTarget;
    } else if (!opts.orphanHistory) {
      throw new BusinessRuleError(
        `Channel has ${convCount} conversations of history. Deleting would orphan them under a dead channel id. `
        + `Reconnect this channel instead, or pass reassignHistoryTo (a live channel) / orphanHistory=true to proceed.`,
        { code: 'channel_has_history', conversationCount: convCount },
      );
    }
  }

  await ChatMapping.deleteMany({ channelId }).exec();
  await Channel.deleteOne({ channelId }).exec();

  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(ch._id),
    actionType: AuditActionType.DELETE,
    performedBy,
    metadata: { transition: 'delete', formerStatus: ch.status, historyReassignedTo, orphanedHistory: convCount > 0 && !historyReassignedTo },
  });
  publishRealtimeEvent('channel.updated', {
    channelId: ch.channelId,
    status: 'deleted',
    transition: 'delete',
  });
}

// ═══════════════════════════════════════════════════════════
// Admin: multi-account session visibility + lock administration
// ═══════════════════════════════════════════════════════════

export interface AdminSessionView {
  channelId: string;
  accountDisplayName: string;
  role: string;
  status: string;
  connectionHealth: string;
  lastInboundAt?: Date;
  lastOutboundAt?: Date;
  lastConnectedAt?: Date;
  lastDisconnectAt?: Date;
  // Live in-process Baileys client (this server instance only).
  hasLiveClient: boolean;
  liveState: string | null;
  lastError?: string;
  // Persisted DB lock — the cross-process truth.
  lock: {
    ownerInstanceId: string | null;
    ownerHeartbeatAt: Date | null;
    ageMs: number | null;
    isStale: boolean;
    isOurs: boolean;
  };
}

export interface AdminSessionsResponse {
  instanceId: string;
  sessions: AdminSessionView[];
}

/** Operator-facing snapshot of every channel's session+lock state.
 *  Combines DB rows, in-process client registry, and persisted lock
 *  ownership into one denormalized list — purpose-built for the
 *  admin "Sessions" UI. */
export async function getAdminSessions(): Promise<AdminSessionsResponse> {
  const [channels, liveSnapshot] = await Promise.all([
    Channel.find({}).sort({ createdAt: 1 }).exec(),
    describeAllSessions(),
  ]);
  const liveByChannel = new Map(liveSnapshot.map((s) => [s.channelId, s]));

  const sessions: AdminSessionView[] = channels.map((ch) => {
    const live = liveByChannel.get(ch.channelId);
    return {
      channelId: ch.channelId,
      accountDisplayName: ch.accountDisplayName,
      role: ch.role,
      status: ch.status,
      connectionHealth: ch.connectionHealth,
      lastInboundAt: ch.lastInboundAt,
      lastOutboundAt: ch.lastOutboundAt,
      lastConnectedAt: ch.lastConnectedAt,
      lastDisconnectAt: ch.lastDisconnectAt,
      hasLiveClient: !!live?.hasLiveClient,
      liveState: live?.state ?? null,
      lastError: live?.lastError,
      lock: live?.lock
        ? {
          ownerInstanceId: live.lock.ownerInstanceId,
          ownerHeartbeatAt: live.lock.ownerHeartbeatAt,
          ageMs: live.lock.ageMs,
          isStale: live.lock.isStale,
          isOurs: live.lock.isOurs,
        }
        : {
          ownerInstanceId: null,
          ownerHeartbeatAt: null,
          ageMs: null,
          isStale: false,
          isOurs: false,
        },
    };
  });

  return { instanceId: INSTANCE_ID, sessions };
}

/** Operator-issued force-release of a channel lock. Refuses when a
 *  live in-process Baileys client is still running for this id —
 *  in that case the operator should logout/stop first. */
export async function adminForceReleaseLock(
  channelId: string,
  reason: string,
  performedBy: string,
): Promise<{
  released: boolean;
  previousOwner: string | null;
  previousHeartbeatAt: Date | null;
  ageMs: number | null;
  lock: LockInfo;
}> {
  const ch = await channelMgr.findById(channelId);
  if (!ch) throw new NotFoundError('Channel', channelId);

  if (getChannelClient(channelId)) {
    throw new BusinessRuleError(
      'A live Baileys session is still running for this channel. Stop or logout the session first.',
      { code: 'session_still_running' },
    );
  }

  const result = await forceReleaseChannelLock(channelId, reason, performedBy);
  const after = await inspectChannelLock(channelId);

  await audit({
    entityType: AuditEntityType.CHANNEL,
    entityId: String(ch._id),
    actionType: AuditActionType.UPDATE,
    performedBy,
    metadata: {
      scope: 'lock_force_released',
      reason,
      previousOwner: result.previousOwner,
      previousHeartbeatAgeMs: result.ageMs,
    },
  });

  publishRealtimeEvent('channel.updated', {
    channelId,
    transition: 'lock_force_released',
  });

  return { ...result, lock: after };
}

// ═══════════════════════════════════════════════════════════
// Downtime coverage reports (post-reconnect verification)
// ═══════════════════════════════════════════════════════════

export interface CoverageReportView {
  id: string;
  channelId: string;
  accountDisplayName?: string;
  offlineFrom: Date;
  offlineTo: Date;
  offlineMs: number;
  messagesInWindow: number;
  chats: ICoverageChatEntry[];
  suspectCount: number;
  createdAt: Date;
}

/** Recent downtime coverage reports, newest first — feeds the operator
 *  banner on the channels page. */
export async function listCoverageReports(
  query: CoverageReportsQuery,
): Promise<CoverageReportView[]> {
  const days = query.days ?? 7;
  const limit = query.limit ?? 10;
  const since = new Date(Date.now() - days * 86_400_000);

  const docs = await CoverageReport.find({ createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .exec();

  return docs.map((d) => ({
    id: String(d._id),
    channelId: d.channelId,
    accountDisplayName: d.accountDisplayName,
    offlineFrom: d.offlineFrom,
    offlineTo: d.offlineTo,
    offlineMs: d.offlineMs,
    messagesInWindow: d.messagesInWindow,
    chats: d.chats ?? [],
    suspectCount: d.suspectCount,
    createdAt: d.createdAt,
  }));
}
