// ═══════════════════════════════════════════════════════════
// Chat discovery — merges three sources into a single list the
// operator can map in the UI:
//
//   1. Live groups from the Baileys socket (if connected) via
//      groupFetchAllParticipating(). Covers groups that haven't
//      posted a message to us yet.
//   2. Existing Conversation rows for this channel — covers
//      private chats we've already seen a message from.
//   3. Existing ChatMapping rows for this channel — so an
//      already-mapped chat keeps its role in the list even if
//      the other two sources haven't surfaced it this minute.
//
// Output is keyed by chatJid (deduped).
// ═══════════════════════════════════════════════════════════

import { MessageIngestionDecision } from '@shadchanai/shared';
import { Conversation, ChatMapping, Message } from '../../models/index.js';
import { getChannelClient } from './providers/baileys/baileys.client.js';

export type DiscoveredRole = 'profiles_source' | 'match_sending' | 'ignore';

export interface DiscoveredChat {
  chatJid: string;
  chatType: 'group' | 'private';
  name: string;
  participantCount?: number;
  // Role as set by the operator via ChatMapping. Undefined = unmapped.
  role?: DiscoveredRole;
  // Informational — when we last saw a message from this chat.
  lastMessageAt?: string;
  // True if a Conversation row already exists for this chat.
  hasConversation: boolean;
  // Conversation id (if there is one) — lets the UI deep-link.
  conversationId?: string;
  // How many inbound messages from this chat were stored but held back
  // by the ingestion gate (decision = ignored_unmapped) — i.e. waiting
  // for the operator to approve the chat as a profiles source. Drives
  // the "Pending" surface and the backfill count.
  pendingMessageCount?: number;
  // When the most recent pending message arrived.
  lastPendingAt?: string;
}

export interface DiscoveryResult {
  channelId: string;
  liveSessionAvailable: boolean;
  /** Live Baileys state of the in-process client (null = no live client). */
  liveState: string | null;
  groupsFetched: number;
  /** Why the live group fetch returned nothing, when it did (not connected / error). */
  groupFetchError?: string;
  chats: DiscoveredChat[];
}

function deriveChatType(jid: string): 'group' | 'private' {
  return jid.endsWith('@g.us') ? 'group' : 'private';
}

export async function discoverChats(channelId: string): Promise<DiscoveryResult> {
  const client = getChannelClient(channelId);
  const liveState = client?.status.state ?? null;
  const liveSessionAvailable = liveState === 'connected';

  // ── 1. Groups from live Baileys session ───────────────
  const liveResult = liveSessionAvailable && client
    ? await client.listGroupChats()
    : { groups: [], error: client ? `session not connected (state=${liveState})` : 'no live client in this process' };
  const liveGroups = liveResult.groups;
  const groupFetchError = liveResult.error;

  // ── 2. Existing conversations for this channel ────────
  const conversations = await Conversation.find({ channelId })
    .select('_id chatJid chatType participantName participantPhone lastMessageAt')
    .lean()
    .exec();

  // ── 3. Operator mappings so they always show with their role ──
  const mappings = await ChatMapping.find({ channelId })
    .select('chatJid chatName chatType role')
    .lean()
    .exec();
  const mappingByJid = new Map(mappings.map((m) => [m.chatJid, m]));

  const map = new Map<string, DiscoveredChat>();
  // conversationId → chatJid, so we can roll up per-message pending counts
  // (Message stores conversationId, not chatJid) onto the chat rows below.
  const convIdToJid = new Map<string, string>();

  // Merge: groups first (live) so later sources fill in missing fields.
  for (const g of liveGroups) {
    map.set(g.jid, {
      chatJid: g.jid,
      chatType: 'group',
      name: g.name,
      participantCount: g.participantCount,
      hasConversation: false,
    });
  }

  // Seed / enrich from conversations.
  for (const c of conversations) {
    // Never DERIVE a jid for a group: a group's participantPhone is the
    // group's numeric id, so derivePrivateJid would forge a bogus
    // "<id>@s.whatsapp.net" private jid — splitting the group off from its
    // real "@g.us" jid (and its mapping/pending count). Only fall back to a
    // derived private jid for actual 1:1 chats.
    const jid = c.chatJid
      ?? (c.chatType === 'group' ? undefined : derivePrivateJid(c.participantPhone));
    if (!jid) continue;
    convIdToJid.set(String(c._id), jid);
    const existing = map.get(jid);
    // Name resolution differs by chat type:
    //  • group   → the conversation's participantName is a SENDER's pushName
    //    (e.g. "נתנאל"), never the group subject. Using it would mislabel the
    //    group. Prefer the live group subject (existing.name from
    //    groupFetchAllParticipating) or the operator's mapping name; fall back
    //    to the jid rather than a member's name.
    //  • private → participantName IS the contact's name — use it first.
    const isGroupChat = c.chatType === 'group' || jid.endsWith('@g.us');
    const mappedName = mappingByJid.get(jid)?.chatName;
    const name = isGroupChat
      ? (existing?.name ?? mappedName ?? jid)
      : (c.participantName ?? existing?.name ?? mappedName ?? jid);
    map.set(jid, {
      chatJid: jid,
      chatType: (c.chatType as 'group' | 'private' | undefined) ?? existing?.chatType ?? deriveChatType(jid),
      name,
      participantCount: existing?.participantCount,
      role: existing?.role,
      lastMessageAt: c.lastMessageAt?.toISOString(),
      hasConversation: true,
      conversationId: String(c._id),
    });
  }

  // Overlay mapping roles. Mapped chats that the other sources
  // haven't surfaced yet still appear — we don't lose them.
  for (const m of mappings) {
    const existing = map.get(m.chatJid);
    if (existing) {
      existing.role = m.role;
      existing.name = existing.name || m.chatName || m.chatJid;
      existing.chatType = existing.chatType ?? (m.chatType as 'group' | 'private');
    } else {
      map.set(m.chatJid, {
        chatJid: m.chatJid,
        chatType: m.chatType as 'group' | 'private',
        name: m.chatName ?? m.chatJid,
        role: m.role,
        hasConversation: false,
      });
    }
  }

  // Also decorate any conversation-source chat that has a
  // mapping row (already handled above via mappingByJid lookup
  // during conversations merge? no — we only set role from
  // existing. Apply here explicitly.)
  for (const entry of map.values()) {
    const m = mappingByJid.get(entry.chatJid);
    if (m && !entry.role) entry.role = m.role;
  }

  // ── 4. Roll up pending (ignored_unmapped) message counts per chat ──
  // One aggregation over this channel's held-back inbound messages,
  // grouped by conversation, then folded onto the chat rows via the
  // conversationId → chatJid map built above.
  const pendingByConv = await Message.aggregate<{ _id: unknown; count: number; lastAt: Date }>([
    { $match: { channelId, 'ingestion.decision': MessageIngestionDecision.IGNORED_UNMAPPED } },
    { $group: { _id: '$conversationId', count: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
  ]).exec();

  for (const row of pendingByConv) {
    const jid = convIdToJid.get(String(row._id));
    if (!jid) continue;
    const entry = map.get(jid);
    if (!entry) continue;
    entry.pendingMessageCount = (entry.pendingMessageCount ?? 0) + row.count;
    const at = row.lastAt ? new Date(row.lastAt).toISOString() : undefined;
    if (at && (!entry.lastPendingAt || at > entry.lastPendingAt)) entry.lastPendingAt = at;
  }

  const chats = [...map.values()].sort((a, b) => {
    // Unmapped first (so operators see new work), then by last activity desc.
    if (!!a.role !== !!b.role) return a.role ? 1 : -1;
    const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    if (at !== bt) return bt - at;
    // Stable tiebreaker by chatJid so equal-ranked rows keep a fixed order
    // across refetches — otherwise a row can jump under the operator's
    // cursor right as they click approve/ignore on the row next to it.
    return a.chatJid.localeCompare(b.chatJid);
  });

  return {
    channelId,
    liveSessionAvailable,
    liveState,
    groupsFetched: liveGroups.length,
    groupFetchError,
    chats,
  };
}

function derivePrivateJid(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/[^\d]/g, '');
  if (!digits) return undefined;
  return `${digits}@s.whatsapp.net`;
}
