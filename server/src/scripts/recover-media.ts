// ═══════════════════════════════════════════════════════════
// recover-media — one-time bulk recovery of image downloads that
// previously failed with "bad decrypt" (corrupted mediaKey from the
// Mongo round-trip, fixed in media.service.restoreMediaBinaries).
//
//   npx tsx src/scripts/recover-media.ts            (run from server/)
//
// The media-download-reconciler job won't touch these — most exceeded
// its 3-attempt cap / 24h age window. This calls downloadInboundMedia
// directly (no cap) for every image message missing a mediaUrl, then
// runs the photo backfill so recovered images attach to candidates.
// Blobs older than ~2 weeks may be gone from WhatsApp's CDN — those
// just fail again, which is fine.
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import { connectDB, disconnectDB } from '../config/db.js';
import { Message } from '../models/index.js';
import { downloadInboundMedia } from '../services/whatsapp/media.service.js';
import { runPhotoStorageMaintenance } from '../services/storage/photo-maintenance.service.js';

async function main(): Promise<void> {
  await connectDB();

  const failed = await Message.find({ contentType: 'image', mediaUrl: { $exists: false } })
    .sort({ createdAt: -1 })
    .select('_id createdAt')
    .lean()
    .exec();

  console.log(`Found ${failed.length} image messages without a download. Re-attempting…\n`);

  let ok = 0;
  let deadKey = 0;
  let other = 0;
  for (let i = 0; i < failed.length; i++) {
    const res = await downloadInboundMedia(String(failed[i]!._id));
    if (res.ok) {
      ok++;
    } else if ((res.reason ?? '').includes('bad decrypt') || (res.reason ?? '').includes('404') || (res.reason ?? '').includes('410')) {
      deadKey++;
    } else {
      other++;
    }
    if ((i + 1) % 25 === 0) console.log(`  …${i + 1}/${failed.length}  (ok=${ok} dead=${deadKey} other=${other})`);
  }

  console.log(`\nDownload recovery: ok=${ok}  dead/expired=${deadKey}  other=${other}`);

  console.log('\nAttaching recovered images to candidates (photo backfill)…');
  const r = await runPhotoStorageMaintenance();
  console.log('  maintenance:', r);

  await disconnectDB();
  process.exit(0);
}

void main();
