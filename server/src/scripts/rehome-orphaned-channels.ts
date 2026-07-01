// ═══════════════════════════════════════════════════════════
// Recovery migration: re-home conversations + messages that were
// orphaned when their Channel was deleted (deleteChannelSafely wipes
// the Channel row but leaves history behind, referencing a channelId
// that no longer exists — invisible to discovery/pending).
//
// Re-homes every orphaned Conversation/Message onto the live target
// channel, stamping `migratedFromChannelId` for reversibility, and
// normalizes never-gated inbound messages to `ignored_unmapped` so
// they surface as pending and become backfill-processable.
//
//   Dry run (default):  tsx src/scripts/rehome-orphaned-channels.ts
//   Apply:              tsx src/scripts/rehome-orphaned-channels.ts --apply
//   Explicit target:    ... --target ch_xxxxxxxx
// ═══════════════════════════════════════════════════════════
import dns from 'node:dns';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../config/db.js';
import { Channel, Message, Conversation } from '../models/index.js';

try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch { /* best-effort */ }

const APPLY = process.argv.includes('--apply');
const targetArg = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

async function main(): Promise<void> {
  await connectDB();

  const liveChannels = await Channel.find({}).select('channelId status role').lean().exec();
  const liveIds = new Set((liveChannels as any[]).map((c) => c.channelId));
  console.log(`live channels: ${[...liveIds].join(', ') || '(none)'}`);

  // Pick target: explicit arg, else the single active channel.
  const active = (liveChannels as any[]).filter((c) => c.status === 'active');
  const target = targetArg ?? (active.length === 1 ? active[0].channelId : undefined);
  if (!target || !liveIds.has(target)) {
    console.error(
      `\n✖ Cannot resolve a target channel. `
      + (active.length === 1 ? '' : `Found ${active.length} active channels — pass --target ch_xxx explicitly.`),
    );
    await shutdown();
    process.exit(1);
  }
  console.log(`target (re-home onto): ${target}\n`);

  // Orphaned channelIds = referenced by Messages/Conversations but not a live Channel.
  const msgChannelIds = await Message.distinct('channelId');
  const convChannelIds = await Conversation.distinct('channelId');
  const orphanIds = [...new Set([...msgChannelIds, ...convChannelIds])].filter(
    (id) => id && !liveIds.has(id),
  );

  if (orphanIds.length === 0) {
    console.log('✓ No orphaned channels — nothing to re-home.');
    await shutdown();
    return;
  }

  console.log(`orphaned channelIds (${orphanIds.length}): ${orphanIds.join(', ')}\n`);

  const convCount = await Conversation.countDocuments({ channelId: { $in: orphanIds } });
  const msgCount = await Message.countDocuments({ channelId: { $in: orphanIds } });
  const normalizeCount = await Message.countDocuments({
    channelId: { $in: orphanIds },
    direction: 'inbound',
    'ingestion.decision': { $exists: false },
  });

  console.log('WOULD ' + (APPLY ? 'APPLY' : 'DRY-RUN') + ':');
  console.log(`  • re-home ${convCount} conversations → ${target}`);
  console.log(`  • re-home ${msgCount} messages → ${target}`);
  console.log(`  • normalize ${normalizeCount} never-gated inbound messages → ignored_unmapped (become pending/backfillable)`);

  if (!APPLY) {
    console.log('\n(dry-run — no writes. Re-run with --apply to perform the migration.)');
    await shutdown();
    return;
  }

  // Raw collection ops so we can write the reversibility field (migratedFromChannelId)
  // without mongoose strict-mode stripping it. Pipeline update preserves the old id.
  const convRes = await Conversation.collection.updateMany(
    { channelId: { $in: orphanIds } },
    [{ $set: { migratedFromChannelId: { $ifNull: ['$migratedFromChannelId', '$channelId'] }, channelId: target } }],
  );
  const msgRes = await Message.collection.updateMany(
    { channelId: { $in: orphanIds } },
    [{ $set: { migratedFromChannelId: { $ifNull: ['$migratedFromChannelId', '$channelId'] }, channelId: target } }],
  );
  const normRes = await Message.collection.updateMany(
    { channelId: target, migratedFromChannelId: { $in: orphanIds }, direction: 'inbound', 'ingestion.decision': { $exists: false } },
    { $set: { ingestion: { decision: 'ignored_unmapped', decidedAt: new Date(), migratedNormalized: true } } },
  );

  console.log('\n✓ APPLIED:');
  console.log(`  • conversations modified: ${convRes.modifiedCount}`);
  console.log(`  • messages re-homed: ${msgRes.modifiedCount}`);
  console.log(`  • messages normalized to ignored_unmapped: ${normRes.modifiedCount}`);
  console.log('\nNext: open /channels/pending on the target channel, map the real groups as "מקור פרופילים", and approve+backfill.');

  await shutdown();
}

async function shutdown(): Promise<void> {
  await disconnectDB();
  await mongoose.connection.close();
}

main().catch((e) => { console.error('MIGRATION ERROR:', e); process.exit(1); });
