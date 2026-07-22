// ═══════════════════════════════════════════════════════════
// One-off backfill: re-run extraction on every needs_review message
// EXCEPT suspected duplicates (those need a manual link decision, not
// another AI pass). After the "structured AI agreement" corroboration fix
// (orchestrator.ts), label-less cards our AI reads confidently now
// auto-create instead of sitting in the queue forever.
//
//   npx tsx src/scripts/reprocess-nondupe-review.ts --dry          # report only
//   npx tsx src/scripts/reprocess-nondupe-review.ts --limit 20     # first 20 for real
//   npx tsx src/scripts/reprocess-nondupe-review.ts                # the whole backlog
// ═══════════════════════════════════════════════════════════
import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
import { connectDB, disconnectDB } from '../config/db.js';
import { Message } from '../models/index.js';
import { processMessageExtraction } from '../services/extraction/orchestrator.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const limitArg = args.find((a) => a.startsWith('--limit'));
const limit = limitArg ? Number(limitArg.split('=')[1] ?? args[args.indexOf(limitArg) + 1]) : 0;
const SPACING_MS = Number(process.env['REPROCESS_SPACING_MS']) || 1500;

const NEEDS_REVIEW = 'needs_review';
// Everything awaiting review that ISN'T a suspected duplicate and isn't
// currently claimed by an operator mid-review.
const FILTER = {
  'extraction.status': NEEDS_REVIEW,
  'extraction.reviewReason': { $ne: 'suspected_duplicate' },
  'extraction.reviewClaimedAt': { $exists: false },
};

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  await connectDB();

  const total = await Message.countDocuments(FILTER);
  const byReason = await Message.aggregate([
    { $match: FILTER },
    { $group: { _id: '$extraction.reviewReason', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log(`\nEligible (needs_review, NOT suspected_duplicate, unclaimed): ${total}`);
  for (const r of byReason) console.log(`  ${r._id ?? '(none)'}: ${r.n}`);

  if (dry) {
    console.log('\n[DRY RUN] nothing processed. Re-run without --dry to execute.');
    await disconnectDB();
    return;
  }

  const query = Message.find(FILTER).select('_id').sort({ 'extraction.completedAt': 1 });
  if (limit > 0) query.limit(limit);
  const ids = (await query.lean().exec()).map((m) => String(m._id));

  console.log(`\nProcessing ${ids.length} message(s), ~${SPACING_MS}ms apart…\n`);
  const tally: Record<string, number> = {};
  let i = 0;
  for (const id of ids) {
    i += 1;
    try {
      const outcome = await processMessageExtraction(id);
      tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
      if (outcome.status === 'created_new' || outcome.status === 'matched_existing') {
        console.log(`  [${i}/${ids.length}] ${outcome.status}  conf=${outcome.confidence.toFixed(2)}  candidate=${outcome.candidateId ?? ''}`);
      }
    } catch (err) {
      tally['error'] = (tally['error'] ?? 0) + 1;
      console.log(`  [${i}/${ids.length}] ERROR ${(err as Error).message}`);
    }
    if (i % 25 === 0) console.log(`  … ${i}/${ids.length} done`);
    await sleep(SPACING_MS);
  }

  console.log('\n── Outcome tally ──');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

  const remaining = await Message.countDocuments(FILTER);
  console.log(`\nStill needs_review (non-dupe, unclaimed): ${remaining}`);
  await disconnectDB();
}

main().catch((e) => { console.error(e); process.exit(1); });
