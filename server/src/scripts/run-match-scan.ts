// ═══════════════════════════════════════════════════════════
// One-off match-scan runner. Re-scores internal↔external pairs and
// refreshes the PairScore cache the UI reads. Use after an engine change:
// ENGINE_VERSION is baked into the scoring hash, so an 'incremental' scan
// treats every pair as dirty and re-scores it with the current logic.
//
// Usage:
//   npx tsx src/scripts/run-match-scan.ts            # incremental (default)
//   MODE=full npx tsx src/scripts/run-match-scan.ts  # full sweep
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import { connectDB, disconnectDB } from '../config/db.js';
import { runScanNow } from '../services/matching/match-scan.service.js';
import { createManualSuggestion } from '../modules/matches/match.service.js';

const MODE = (process.env['MODE'] === 'full' ? 'full' : 'incremental') as 'incremental' | 'full';

async function main(): Promise<void> {
  await connectDB();
  console.log(`\nStarting ${MODE} match scan…`);
  const summary = await runScanNow({
    trigger: 'manual',
    mode: MODE,
    createSuggestion: createManualSuggestion,
  });
  console.log('Scan summary:', JSON.stringify(summary, null, 2));
  await disconnectDB();
}

main().catch((e) => { console.error(e); process.exit(1); });
