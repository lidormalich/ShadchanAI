// ═══════════════════════════════════════════════════════════
// Migration: openToDivorced → tri-state.
//
// The internal openness.openToDivorced flag used to default to `false` in
// the schema, so nearly every candidate has a stored `false` that was never
// an intentional operator choice — it was the default. The matching engine
// now treats an explicit `false` as "לא" (a hard block on divorced/separated
// candidates). Left as-is, those accidental defaults would wrongly block
// legitimate pairs (e.g. a divorced candidate ↔ a divorcee).
//
// This migration UNSETS every `openToDivorced: false`, turning it back into
// "unknown" (undefined) — no block, soft penalty for singles. Going forward,
// an operator clicking "לא" in the form persists a real `false` that blocks.
// `true` values are left untouched.
//
// Usage:
//   DRY_RUN=true npx tsx src/scripts/migrate-openness-tristate.ts
//                npx tsx src/scripts/migrate-openness-tristate.ts
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import { connectDB, disconnectDB } from '../config/db.js';
import { InternalCandidate } from '../modules/candidates/internal-candidate.model.js';

const DRY_RUN = process.env['DRY_RUN'] === 'true';

async function main(): Promise<void> {
  await connectDB();

  const filter = { 'openness.openToDivorced': false };
  const affected = await InternalCandidate.countDocuments(filter).exec();
  const total = await InternalCandidate.countDocuments({}).exec();
  console.log(`\nInternal candidates: ${total} total, ${affected} with openToDivorced=false (accidental default).`);

  if (affected === 0) {
    console.log('Nothing to migrate.');
    await disconnectDB();
    return;
  }

  if (DRY_RUN) {
    console.log(`DRY_RUN — would unset openToDivorced on ${affected} document(s). No changes written.`);
    await disconnectDB();
    return;
  }

  const res = await InternalCandidate.updateMany(
    filter,
    { $unset: { 'openness.openToDivorced': '' } },
  ).exec();
  console.log(`Unset openToDivorced on ${res.modifiedCount} document(s) → now "unknown".`);
  console.log('Re-run the match scan so cached PairScore rows reflect the change.');

  await disconnectDB();
}

main().catch((e) => { console.error(e); process.exit(1); });
