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

import { Conversation, ChatMapping } from '../../models/index.js';
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
}

export interface DiscoveryResult {
  channelId: string;
  liveSessionAvailable: boolean;
  groupsFetched: number;
  chats: DiscoveredChat[];
}

function deriveChatType(jid: string): 'group' | 'private' {
  return jid.endsWith('@g.us') ? 'group' : 'private';
}

export async function discoverChats(channelId: string): Promise<DiscoveryResult> {
  const client = getChannelClient(channelId);
  const liveSessionAvailable = !!client && client.status.state === 'connected';

  // ── 1. Groups from live Baileys session ───────────────
  const liveGroups = liveSessionAvailable && client
    ? await client.listGroupChats()
    : [];

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
    const jid = c.chatJid ?? derivePrivateJid(c.participantPhone);
    if (!jid) continue;
    const existing = map.get(jid);
    const name = c.participantName ?? existing?.name ?? jid;
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

  const chats = [...map.values()].sort((a, b) => {
    // Unmapped first (so operators see new work), then by last activity desc.
    if (!!a.role !== !!b.role) return a.role ? 1 : -1;
    const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bt - at;
  });

  return {
    channelId,
    liveSessionAvailable,
    groupsFetched: liveGroups.length,
    chats,
  };
}

function derivePrivateJid(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/[^\d]/g, '');
  if (!digits) return undefined;
  return `${digits}@s.whatsapp.net`;
}
