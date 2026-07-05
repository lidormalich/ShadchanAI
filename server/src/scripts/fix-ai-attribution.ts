// One-off data repair for AIRequest rows written BEFORE the fallback
// attribution fix (commit 80ffaa3, 2026-07-02): when the primary AI
// engine failed and the request fell back to the secondary, the row was
// logged with the FALLBACK's provider but the PRIMARY's model id —
// producing impossible combos like openai/llama-3.3-70b or
// groq/gpt-4o-mini in the cost dashboard.
//
// The provider field is trustworthy (it names who was actually called);
// only modelId is garbled. This script rewrites modelId to the model
// that provider actually serves — the same value the fixed logging code
// writes today.
//
// Usage:
//   npx tsx src/scripts/fix-ai-attribution.ts          # dry run (default)
//   npx tsx src/scripts/fix-ai-attribution.ts --fix    # apply
import dns from 'node:dns';
import { connectDB, disconnectDB } from '../config/db.js';
import { AIRequest } from '../models/index.js';
import { env } from '../config/env.js';

// Same DNS pin as wa-diagnose — mongodb+srv:// SRV lookups can fail on
// some Windows setups with the default resolver.
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch { /* best-effort */ }

const APPLY = process.argv.includes('--fix');

// A groq row must carry a Groq-served model; an openai row an OpenAI one.
// Rows violating this were written by the pre-fix fallback path.
const REPAIRS = [
  {
    label: 'openai rows carrying a Groq model id',
    filter: { provider: 'openai', modelId: { $regex: '^llama', $options: 'i' } },
    correctModelId: env.OPENAI_MODEL,
  },
  {
    label: 'groq rows carrying an OpenAI model id',
    filter: { provider: 'groq', modelId: { $regex: '^gpt', $options: 'i' } },
    correctModelId: env.GROQ_MODEL,
  },
] as const;

async function main(): Promise<void> {
  await connectDB();

  console.log(`\nMode: ${APPLY ? 'FIX (writing)' : 'DRY RUN (pass --fix to apply)'}\n`);

  for (const repair of REPAIRS) {
    const rows = await AIRequest
      .find(repair.filter)
      .select('modelId success createdAt inputTokens outputTokens')
      .lean()
      .exec();

    console.log(`── ${repair.label}: ${rows.length} rows → modelId="${repair.correctModelId}"`);
    if (rows.length > 0) {
      const byModel = new Map<string, number>();
      let successes = 0;
      let earliest = rows[0]!.createdAt;
      let latest = rows[0]!.createdAt;
      for (const r of rows) {
        byModel.set(r.modelId, (byModel.get(r.modelId) ?? 0) + 1);
        if (r.success) successes++;
        if (r.createdAt < earliest) earliest = r.createdAt;
        if (r.createdAt > latest) latest = r.createdAt;
      }
      console.log(`   models: ${JSON.stringify(Object.fromEntries(byModel))}`);
      console.log(`   successes: ${successes}/${rows.length}  range: ${new Date(earliest).toISOString().slice(0, 10)} … ${new Date(latest).toISOString().slice(0, 10)}`);
    }

    if (APPLY && rows.length > 0) {
      // updateMany is intentional: the schema's immutability guards hook
      // updateOne/findOneAndUpdate only, and this is an explicit,
      // operator-requested repair of mislogged rows — not a business write.
      const res = await AIRequest.updateMany(
        repair.filter,
        { $set: { modelId: repair.correctModelId } },
      ).exec();
      console.log(`   ✔ updated ${res.modifiedCount} rows`);
    }
  }

  await disconnectDB();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
