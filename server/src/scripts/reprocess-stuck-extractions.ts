// ═══════════════════════════════════════════════════════════
// Re-run extraction on messages stuck in needs_review.
//
// After the zero-width-label fix (templates.ts), emoji-decorated
// image-caption cards that previously extracted ONLY a phone (→
// reviewReason 'no_corroboration' → parked in needs_review) now
// parse fully. This re-runs the SAME production pipeline on those
// stuck messages so they auto-create candidates (or link/route as
// the matcher decides) instead of waiting for manual approval.
//
// Scope (safe subset): only reviewReason in REASONS (default
// no_corroboration + low_confidence) and NOT already claimed by an
// operator mid-approval. Vision-image and suspected-duplicate rows
// are LEFT for human review.
//
// DRY RUN by default:
//   npx tsx src/scripts/reprocess-stuck-extractions.ts             # report
//   APPLY=true npx tsx src/scripts/reprocess-stuck-extractions.ts  # re-run
// Env: REASONS=no_corroboration,low_confidence  LIMIT=1000
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import mongoose from 'mongoose';
import { MessageExtractionStatus } from '@shadchanai/shared';
import { env } from '../config/env.js';
import { Message } from '../models/index.js';
import { processMessageExtraction } from '../services/extraction/orchestrator.js';

const APPLY = process.env['APPLY'] === 'true';
const REASONS = (process.env['REASONS'] ?? 'no_corroboration,low_confidence').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(process.env['LIMIT'] ?? 1000);

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  console.error(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'} | reasons: [${REASONS.join(', ')}]`);

  const stuck = await Message.find({
    'extraction.status': MessageExtractionStatus.NEEDS_REVIEW,
    'extraction.reviewReason': { $in: REASONS },
    'extraction.reviewClaimedAt': { $exists: false },
  }).select('_id').limit(LIMIT).lean().exec();

  console.error(`Found ${stuck.length} stuck message(s).`);
  if (!APPLY) {
    console.error('Dry run: no reprocessing. Re-run with APPLY=true.');
    await mongoose.disconnect();
    return;
  }

  const outcomes: Record<string, number> = {};
  let i = 0;
  for (const m of stuck) {
    const res = await processMessageExtraction(String(m._id));
    outcomes[res.status] = (outcomes[res.status] ?? 0) + 1;
    i += 1;
    if (i % 25 === 0) console.error(`  …${i}/${stuck.length}`);
    // Small spacing — most now skip AI (regex is rich), but guard the few that don't.
    await sleep(150);
  }

  console.error(`\nDone. Reprocessed ${stuck.length}. Outcomes: ${JSON.stringify(outcomes, null, 2)}`);
  await mongoose.disconnect();
}

void main().catch((e) => { console.error('reprocess-stuck-extractions failed:', e); process.exit(1); });
