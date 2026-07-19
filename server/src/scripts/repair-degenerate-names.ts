// ═══════════════════════════════════════════════════════════
// Repair "degenerate name" external candidates — cards where
// firstName === lastName (e.g. "בוחניק בוחניק", "כהן כהן").
//
// These are mis-extractions from the old parser: a "שם משפחה" line
// prefix-matched the 'שם' label and its value OVERWROTE the given name,
// so the surname landed in BOTH fields. When several such cards share a
// surname + the shadchan's phone, the matcher's name+phone "exact" tier
// even FUSED different people into one card (the "בוחניק בוחניק" incident:
// רינה 27 + יעל 35 → one card).
//
// The parser + matcher are now fixed (a "שם משפחה" line has its own field;
// degenerate names never drive a merge). This backfill re-runs each broken
// card's SOURCE MESSAGES through the real production pipeline, so each is
// re-extracted with the correct name and linked/created/deduped properly —
// exactly as if the cards had just arrived.
//
// Safety:
//   • DRY RUN by default — reports the plan, changes nothing.
//   • Skips cards that have MatchSuggestions or PairReviews (real
//     matchmaking work depends on them — handle by hand).
//   • Skips cards with no source message (nothing to reprocess — likely
//     manually created; fix in the UI).
//   • Logs the FULL json of every card before deleting it (recoverable).
//
//   npx tsx src/scripts/repair-degenerate-names.ts             # dry run
//   APPLY=true npx tsx src/scripts/repair-degenerate-names.ts  # execute
//   LIMIT=5 APPLY=true npx tsx ...                             # cap the batch
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { ExternalCandidate, MatchSuggestion, PairReview } from '../models/index.js';
import { processMessageExtraction } from '../services/extraction/orchestrator.js';

const APPLY = process.env['APPLY'] === 'true';
const LIMIT = Number(process.env['LIMIT'] ?? 500);

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
const norm = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// Placeholder "names" the extractor sometimes emits for a card with no name.
const PLACEHOLDER_NAMES = new Set(['לא צויין', 'לא ידוע', 'אנונימי', 'ללא שם']);

// Is the (duplicated) name just an INITIAL rather than a real word? Initial-only
// cards ("א.", "ב.ש.", "ה.") came from a source that gave only an initial — the
// source has no fuller given name to recover, so reprocessing can't fix them and
// would only un-dedup their (currently consolidated) reposts into review noise.
// A real surname ("חדד", "בוחניק", "כהן") has ≥3 letters once dots/spaces drop.
function isInitialOnly(name: string): boolean {
  if (PLACEHOLDER_NAMES.has(name.trim())) return true;
  const letters = name.replace(/[.\s]/g, '');
  return letters.length <= 2;
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  console.error(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'} | limit: ${LIMIT}`);

  // Find active cards where firstName === lastName (trimmed, case-insensitive).
  const active = await ExternalCandidate.find({
    status: { $ne: 'archived' },
    firstName: { $exists: true, $ne: '' },
    lastName: { $exists: true, $ne: '' },
  }).select('_id firstName lastName age sourceMessageIds').lean().exec();
  const degenerate = active.filter((c) => norm(c.firstName) === norm(c.lastName));

  // Classify each card.
  type Plan = { id: string; name: string; firstName: string; age?: number; sources: string[]; suggestions: number; pairReviews: number; decision: 'repair' | 'skip_refs' | 'skip_no_source' | 'skip_initial' };
  const plans: Plan[] = [];
  for (const c of degenerate) {
    const id = String(c._id);
    const sources = (c.sourceMessageIds ?? []).map(String);
    const [suggestions, pairReviews] = await Promise.all([
      MatchSuggestion.countDocuments({ externalCandidateId: c._id }).exec(),
      PairReview.countDocuments({ externalCandidateId: c._id }).exec(),
    ]);
    let decision: Plan['decision'] = 'repair';
    if (suggestions > 0 || pairReviews > 0) decision = 'skip_refs';
    else if (sources.length === 0) decision = 'skip_no_source';
    else if (isInitialOnly(c.firstName ?? '')) decision = 'skip_initial';
    plans.push({ id, name: `${c.firstName} ${c.lastName}`, firstName: c.firstName ?? '', age: c.age, sources, suggestions, pairReviews, decision });
  }

  const allRepairable = plans.filter((p) => p.decision === 'repair');
  const repair = allRepairable.slice(0, LIMIT);
  const skipRefs = plans.filter((p) => p.decision === 'skip_refs');
  const skipNoSrc = plans.filter((p) => p.decision === 'skip_no_source');
  const skipInitial = plans.filter((p) => p.decision === 'skip_initial');

  console.error(`\nDegenerate-name cards: ${degenerate.length}`);
  console.error(`  → repair (surname mislabel, has sources, no refs): ${allRepairable.length}${repair.length < allRepairable.length ? ` (capped to ${repair.length})` : ''}`);
  console.error(`  → SKIP (initial-only / placeholder — reprocessing can't recover a name): ${skipInitial.length}`);
  console.error(`  → SKIP (has suggestions/pair-reviews): ${skipRefs.length}`);
  console.error(`  → SKIP (no source message): ${skipNoSrc.length}`);
  if (skipInitial.length) console.error(`     initial-only: ${skipInitial.map((p) => `${p.name}[${p.id.slice(-6)}]×${p.sources.length}`).join(', ')}`);
  if (skipRefs.length) console.error(`     refs: ${skipRefs.map((p) => `${p.name}[${p.id.slice(-6)}] s${p.suggestions}/p${p.pairReviews}`).join(', ')}`);
  if (skipNoSrc.length) console.error(`     no-source: ${skipNoSrc.map((p) => `${p.name}[${p.id.slice(-6)}]`).join(', ')}`);

  console.error('\nRepair plan:');
  for (const p of repair) console.error(`  ${p.name} (age ${p.age ?? '?'}) [${p.id.slice(-6)}] — ${p.sources.length} source msg(s)`);

  if (!APPLY) {
    console.error('\nDry run: nothing changed. Re-run with APPLY=true.');
    await mongoose.disconnect();
    return;
  }

  // Execute: for each repairable card, back it up, delete it, reprocess its
  // source messages through the real pipeline.
  const outcomeCounts: Record<string, number> = {};
  const resultCandidateIds = new Set<string>();
  let done = 0;
  for (const p of repair) {
    const full = await ExternalCandidate.findById(p.id).lean().exec();
    console.error(`\n[BACKUP] ${p.name} [${p.id}]: ${JSON.stringify(full)}`);
    await ExternalCandidate.deleteOne({ _id: new mongoose.Types.ObjectId(p.id) }).exec();
    for (const mid of p.sources) {
      const res = await processMessageExtraction(mid);
      outcomeCounts[res.status] = (outcomeCounts[res.status] ?? 0) + 1;
      if (res.candidateId) resultCandidateIds.add(res.candidateId);
      console.error(`   msg ${mid.slice(-6)} → ${res.status}${res.candidateId ? ` (${res.candidateId.slice(-6)})` : ''}`);
      await sleep(300);
    }
    done += 1;
    if (done % 5 === 0) console.error(`  …${done}/${repair.length}`);
  }

  console.error(`\n=== Done. Repaired ${repair.length} card(s). Outcomes: ${JSON.stringify(outcomeCounts)} ===`);
  console.error('Resulting candidates:');
  for (const id of resultCandidateIds) {
    const c = await ExternalCandidate.findById(id).select('firstName lastName age city photoStorageKey sourceMessageIds').lean().exec();
    if (c) console.error(`  ${c.firstName} ${c.lastName} (age ${c.age ?? '?'}, ${c.city ?? '?'}) [${id.slice(-6)}] photo:${!!c.photoStorageKey} sources:${(c.sourceMessageIds ?? []).length}`);
  }

  // Re-scan for any degenerate names that survived (should be ~0 for repaired ones).
  const after = await ExternalCandidate.find({
    status: { $ne: 'archived' }, firstName: { $exists: true, $ne: '' }, lastName: { $exists: true, $ne: '' },
  }).select('firstName lastName').lean().exec();
  const stillDegenerate = after.filter((c) => norm(c.firstName) === norm(c.lastName));
  console.error(`\nDegenerate-name cards remaining: ${stillDegenerate.length} (skipped refs/no-source excluded from repair)`);

  await mongoose.disconnect();
}
void main().catch((e) => { console.error('repair-degenerate-names failed:', e); process.exit(1); });
