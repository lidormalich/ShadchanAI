// Read-only WhatsApp health diagnostic. Connects to the app DB and prints
// the state that decides whether WhatsApp actually works: channels, their
// locks, chat mappings, and how inbound messages were gated.
import dns from 'node:dns';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../config/db.js';
import { Channel, Message, Conversation, ChatMapping } from '../models/index.js';

// Node's c-ares resolver can default to a DNS server that refuses on some
// Windows/Git-Bash setups (querySrv ECONNREFUSED) even when the OS resolver
// works. Pin public resolvers so mongodb+srv:// lookups succeed.
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch { /* best-effort */ }

const STALE_MS = 60_000;

function fmtAge(d?: Date | null): string {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

async function main(): Promise<void> {
  await connectDB();

  const channels = await Channel.find({}).lean().exec();
  console.log(`\n══════ CHANNELS (${channels.length}) ══════`);
  for (const c of channels as any[]) {
    const owner = c.ownerInstanceId ?? null;
    const hbAge = c.ownerHeartbeatAt ? Date.now() - new Date(c.ownerHeartbeatAt).getTime() : null;
    const stale = !!owner && hbAge !== null && hbAge > STALE_MS;
    console.log(
      `\n• ${c.accountDisplayName}  [${c.channelId}]`
      + `\n    role=${c.role}  status=${c.status}  health=${c.connectionHealth}  webhook=${c.webhookStatus}`
      + `\n    phone=${c.phoneNumber || '(none)'}  lastConnectedAt=${c.lastConnectedAt ? new Date(c.lastConnectedAt).toISOString() : '—'}`
      + `\n    LOCK: owner=${owner ?? '(free)'}  heartbeatAge=${fmtAge(c.ownerHeartbeatAt)}  ${stale ? '⚠️ STALE' : owner ? 'fresh' : ''}`
      + (c.statusReason ? `\n    statusReason=${c.statusReason}` : ''),
    );

    const maps = await ChatMapping.find({ channelId: c.channelId }).lean().exec();
    const byRole: Record<string, number> = {};
    for (const m of maps as any[]) byRole[m.role] = (byRole[m.role] ?? 0) + 1;
    console.log(`    mappings: ${maps.length} ${JSON.stringify(byRole)}`);

    const convCount = await Conversation.countDocuments({ channelId: c.channelId });
    const msgAgg = await Message.aggregate([
      { $match: { channelId: c.channelId } },
      { $group: { _id: '$ingestion.decision', n: { $sum: 1 } } },
    ]);
    const decisions = Object.fromEntries(msgAgg.map((r: any) => [r._id ?? 'none', r.n]));
    console.log(`    conversations=${convCount}  messages by ingestion.decision=${JSON.stringify(decisions)}`);
  }

  // Global inbound totals — did ANY WhatsApp message ever land?
  const totalInbound = await Message.countDocuments({ direction: 'inbound' });
  console.log(`\n══════ TOTALS ══════`);
  console.log(`inbound messages=${totalInbound}`);

  // Global breakdown of ALL messages by ingestion.decision (incl. missing).
  const globalDecisions = await Message.aggregate([
    { $group: { _id: '$ingestion.decision', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log('by ingestion.decision:', JSON.stringify(Object.fromEntries(globalDecisions.map((r: any) => [r._id ?? 'MISSING', r.n]))));

  // Which channelIds do Messages actually carry? (detect ghost/old channels)
  const byChannel = await Message.aggregate([
    { $group: { _id: '$channelId', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log('messages by channelId:', JSON.stringify(Object.fromEntries(byChannel.map((r: any) => [r._id ?? 'MISSING', r.n]))));

  // For each profiles_source mapping, does its chatJid match real traffic?
  console.log(`\n══════ profiles_source MAPPINGS vs TRAFFIC ══════`);
  const psMaps = await ChatMapping.find({ role: 'profiles_source' }).lean().exec();
  for (const m of psMaps as any[]) {
    const convs = await Conversation.find({ channelId: m.channelId, chatJid: m.chatJid }).select('_id').lean().exec();
    const convIds = convs.map((c: any) => c._id);
    const msgs = convIds.length
      ? await Message.countDocuments({ conversationId: { $in: convIds } })
      : 0;
    console.log(`• "${m.chatName ?? m.chatJid}"  jid=${m.chatJid}\n    conversations=${convs.length}  messages=${msgs}`);
  }

  // What chatJids do conversations actually have? (compare against mappings)
  console.log(`\n══════ CONVERSATIONS (chatJid → messages) ══════`);
  const convs = await Conversation.find({}).select('_id chatJid channelId assignedRole').lean().exec();
  for (const c of convs as any[]) {
    const n = await Message.countDocuments({ conversationId: c._id });
    console.log(`• jid=${c.chatJid ?? '(none)'}  role=${c.assignedRole ?? '—'}  channel=${c.channelId}  messages=${n}`);
  }

  await disconnectDB();
  await mongoose.connection.close();
}

main().catch((e) => { console.error('DIAG ERROR:', e); process.exit(1); });
