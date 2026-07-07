// Operator tool: force-release stale WhatsApp channel locks.
//
// Why this exists: when a dev process (tsx watch) or a crashed
// instance dies without a graceful shutdown, its per-channel lock
// lingers on the Channel document with a frozen heartbeat. The next
// process can only reclaim it once the heartbeat ages past STALE_MS
// (60s) — until then boot logs spam `lock_acquire_skipped_held` and
// the watchdog can't reconnect. This clears those dead locks now.
//
// Default: clears every lock whose heartbeat is older than the
// threshold (15s — comfortably above the 20s live-heartbeat cadence
// is NOT used; see note). Pass --all to nuke every lock regardless.
//
//   npm run wa:unlock            # clear aged locks (age > 25s)
//   npm run wa:unlock -- --all   # clear ALL locks (single-instance dev only)
import dns from 'node:dns';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../config/db.js';
import { Channel } from '../models/index.js';

// Mirror wa-diagnose: pin public resolvers so mongodb+srv:// lookups
// succeed on Windows/Git-Bash setups where c-ares defaults refuse.
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch { /* best-effort */ }

// A live client refreshes its heartbeat every 20s. Anything older
// than this is a dead lock the current process is waiting to reclaim.
const AGED_MS = 25_000;

function fmtAge(d?: Date | null): string {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

async function main(): Promise<void> {
  const all = process.argv.includes('--all');
  await connectDB();

  const locked = await Channel.find({ ownerInstanceId: { $ne: null } })
    .select({ channelId: 1, accountDisplayName: 1, ownerInstanceId: 1, ownerHeartbeatAt: 1 })
    .lean()
    .exec();

  if (locked.length === 0) {
    console.log('No held locks. Nothing to release.');
    await disconnectDB();
    await mongoose.connection.close();
    return;
  }

  const cutoff = Date.now() - AGED_MS;
  const targets = (locked as any[]).filter((c) => {
    if (all) return true;
    const hb = c.ownerHeartbeatAt ? new Date(c.ownerHeartbeatAt).getTime() : 0;
    return hb < cutoff; // no/old heartbeat → dead
  });

  console.log(`\n══════ HELD LOCKS (${locked.length}) ══════`);
  for (const c of locked as any[]) {
    const willClear = targets.some((t) => t.channelId === c.channelId);
    console.log(
      `• ${c.accountDisplayName}  [${c.channelId}]`
      + `\n    owner=${c.ownerInstanceId}  heartbeatAge=${fmtAge(c.ownerHeartbeatAt)}`
      + `  → ${willClear ? 'RELEASE' : 'keep (looks live)'}`,
    );
  }

  if (targets.length === 0) {
    console.log('\nAll held locks look live (recent heartbeat). Use -- --all to force.');
  } else {
    const ids = targets.map((t) => t.channelId);
    const res = await Channel.updateMany(
      { channelId: { $in: ids } },
      { $set: { ownerInstanceId: null, ownerHeartbeatAt: null } },
    ).exec();
    console.log(`\n✔ Released ${res.modifiedCount ?? 0} lock(s): ${ids.join(', ')}`);
  }

  await disconnectDB();
  await mongoose.connection.close();
}

main().catch((e) => { console.error('UNLOCK ERROR:', e); process.exit(1); });
