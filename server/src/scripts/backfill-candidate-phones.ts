// ═══════════════════════════════════════════════════════════
// Backfill the labeled `phones[]` list on EXISTING external candidates.
//
// New candidates accumulate every phone they're seen with (card,
// merged duplicates, manual edits), but candidates created before the
// multi-phone feature only carry the scalar contactPhone — numbers
// from merged reposts were discarded at merge time. This script
// recovers them. For every ACTIVE external candidate it unions, in
// order:
//
//   1. its own scalar fields — contactPhone, referencePhone (labeled
//      with the reference name when known);
//   2. phones extracted from EVERY linked source message
//      (sourceMessageIds): the persisted regex+AI profile when the
//      async run stored one, else a fresh regex pass over the text —
//      this is where numbers lost by old merges live, because linking
//      kept the message but dropped its differing phone;
//   3. phones of candidates archived INTO it by old merge runs
//      (staleReason = "merged_duplicate:<survivorId>").
//
// Existing phones[] entries (and their operator-written labels) are
// preserved — the union only ever ADDS numbers. Candidates whose list
// doesn't change are not written at all.
//
// SAFE BY DEFAULT — dry run unless APPLY=true:
//   npx tsx src/scripts/backfill-candidate-phones.ts            # report only
//   APPLY=true npx tsx src/scripts/backfill-candidate-phones.ts # write
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { ExternalCandidate, Message, type IExternalCandidate } from '../models/index.js';
import { extractProfileFromText, type ExtractedProfile } from '../services/extraction/regex.extractor.js';
import { mergePhoneEntries, type PhoneEntry } from '../utils/phone.js';

const APPLY = process.env['APPLY'] === 'true';

type PhoneAdd = { number?: string | null; label?: string; source?: string };

/** A candidate's own scalar phone fields as union additions. */
function scalarPhones(
  c: Pick<IExternalCandidate, 'contactPhone' | 'referencePhone' | 'referenceName'>,
  source: string,
): PhoneAdd[] {
  return [
    ...(c.contactPhone ? [{ number: c.contactPhone, source }] : []),
    ...(c.referencePhone
      ? [{ number: c.referencePhone, label: c.referenceName || 'ממליץ/ה', source: 'reference' }]
      : []),
  ];
}

/** Phones carried by one source message: the persisted extraction profile
 *  when present, else a fresh regex pass over the message text. */
function messagePhones(m: { body?: string; mediaCaption?: string; extraction?: { extractedProfile?: Record<string, unknown> } }): string[] {
  const persisted = m.extraction?.extractedProfile as ExtractedProfile | undefined;
  if (persisted?.contactPhones?.length) return persisted.contactPhones;
  const text = m.body?.trim() || m.mediaCaption?.trim() || '';
  if (!text) return [];
  return extractProfileFromText(text).profile.contactPhones ?? [];
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  console.error(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const candidates = await ExternalCandidate.find({ archivedAt: { $exists: false } }).exec();
  console.error(`Scanning ${candidates.length} active external candidate(s)...\n`);

  let touched = 0;
  let recoveredNumbers = 0;

  for (const c of candidates) {
    // 1. Own scalars (seeds legacy cards that predate phones[]).
    let phones: PhoneEntry[] = mergePhoneEntries(c.phones, scalarPhones(c, 'card'));

    // 2. Every linked source message — reposts merged in the review queue
    //    kept the message link even though their phone was dropped.
    if (c.sourceMessageIds?.length) {
      const messages = await Message.find({ _id: { $in: c.sourceMessageIds } })
        .select('body mediaCaption extraction.extractedProfile')
        .lean()
        .exec();
      for (const m of messages) {
        phones = mergePhoneEntries(
          phones,
          messagePhones(m).map((p) => ({ number: p, source: 'merged_card' })),
        );
      }
    }

    // 3. Losers archived into this candidate by old dedupe:externals runs.
    const losers = await ExternalCandidate.find({
      staleReason: `merged_duplicate:${c._id}`,
    }).select('contactPhone referencePhone referenceName phones').lean().exec();
    for (const loser of losers) {
      phones = mergePhoneEntries(phones, [
        ...(loser.phones ?? []),
        ...scalarPhones(loser, 'merged_card'),
      ]);
    }

    const before = c.phones?.length ?? 0;
    if (phones.length === before) continue; // union only adds — same length ⇒ no change

    touched += 1;
    recoveredNumbers += phones.length - before;
    const name = `${c.firstName ?? '?'} ${c.lastName ?? ''}`.trim();
    console.error(
      `▸ ${name} (${c._id}): ${before} → ${phones.length} phone(s)` +
      (losers.length ? `  [${losers.length} archived merge loser(s)]` : ''),
    );
    for (const p of phones.slice(before)) {
      console.error(`    + ${p.number}${p.label ? `  (${p.label})` : ''}  [${p.source ?? '?'}]`);
    }

    if (APPLY) {
      // Direct field update — skips the full-document save() so the identity
      // pre-save hook / unique index can't interfere with a phones-only write.
      await ExternalCandidate.updateOne({ _id: c._id }, { $set: { phones } }).exec();
    }
  }

  console.error(
    `\n${APPLY ? 'Done.' : 'Dry run: no writes.'} ` +
    `${touched}/${candidates.length} candidate(s) gained numbers; ${recoveredNumbers} number(s) recovered.` +
    (APPLY ? '' : ' Re-run with APPLY=true to write.'),
  );
  await mongoose.disconnect();
}

void main().catch((e) => {
  console.error('backfill-candidate-phones failed:', e);
  process.exit(1);
});
