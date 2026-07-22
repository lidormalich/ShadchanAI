// ═══════════════════════════════════════════════════════════
// Targeted re-run of FAILED extractions whose source text matches a term.
//
// Use after fixing a deterministic extraction bug (e.g. the birth-date-as-age
// age misread): a permanently-FAILED card won't be picked up by the
// needs_review reprocessor, so this finds it by a distinctive substring and
// re-runs processMessageExtraction directly (fresh process → empty AI cache →
// uses the CURRENT working-tree prompt).
//
//   npx tsx src/scripts/reprocess-failed-by-text.ts --grep גרסטנזנג --dry
//   npx tsx src/scripts/reprocess-failed-by-text.ts --grep גרסטנזנג
// ═══════════════════════════════════════════════════════════
import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
import { connectDB, disconnectDB } from '../config/db.js';
import { Message } from '../models/index.js';
import { processMessageExtraction } from '../services/extraction/orchestrator.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const grepIdx = args.indexOf('--grep');
const term = grepIdx >= 0 ? args[grepIdx + 1] : undefined;

if (!term) {
  console.error('Missing --grep <term>. Example: --grep גרסטנזנג');
  process.exit(1);
}

// Escape regex metacharacters so the term is matched literally.
const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

const FILTER = {
  'extraction.status': 'failed',
  $or: [{ body: rx }, { mediaCaption: rx }],
};

async function main() {
  await connectDB();

  const matches = await Message.find(FILTER)
    .select('_id body mediaCaption extraction.status extraction.retryCount extraction.failureReason extraction.permanentFailure')
    .lean()
    .exec();

  console.log(`\nFAILED messages matching /${term}/: ${matches.length}`);
  for (const m of matches) {
    const text = (m.body || m.mediaCaption || '').replace(/\s+/g, ' ').slice(0, 70);
    console.log(`  ${m._id}  retry=${m.extraction?.retryCount ?? 0}  perm=${!!m.extraction?.permanentFailure}`);
    console.log(`     reason: ${m.extraction?.failureReason ?? '(none)'}`);
    console.log(`     text:   ${text}`);
  }

  if (dry) {
    console.log('\n[DRY RUN] nothing processed. Re-run without --dry to execute.');
    await disconnectDB();
    return;
  }

  console.log('\nReprocessing…\n');
  for (const m of matches) {
    const id = String(m._id);
    try {
      const outcome = await processMessageExtraction(id);
      console.log(`  ${id} → ${outcome.status}  conf=${outcome.confidence.toFixed(2)}  candidate=${outcome.candidateId ?? ''}`);
      if (outcome.failureReason) console.log(`     reason: ${outcome.failureReason}`);
    } catch (err) {
      console.log(`  ${id} → ERROR ${(err as Error).message}`);
    }
  }

  await disconnectDB();
}

main().catch((e) => { console.error(e); process.exit(1); });
