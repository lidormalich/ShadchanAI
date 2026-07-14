// ═══════════════════════════════════════════════════════════
// Merge duplicate external candidates (name + exact age).
//
// Backfills the new `identityKey` on every external candidate, then
// finds groups of ACTIVE candidates that share one (same normalized
// firstName|lastName|age) and merges each group down to a single
// survivor:
//
//   - survivor = the richest card (photo + most filled fields +
//     most source messages), tie-broken by earliest createdAt.
//   - source message ids are unioned onto the survivor; empty
//     scalar fields are backfilled from the losers.
//   - every reference to a loser (match suggestions, pair scores,
//     pair reviews, conversations, tasks) is re-pointed to the
//     survivor; a re-point that would violate a unique pair index
//     drops the loser's now-redundant row.
//   - losers are archived (status=archived, staleReason=merged...).
//
// ONLY exact name+age duplicates are merged (the confident case).
// Fuzzy near-duplicates (age ±1, name-only) are left untouched for
// the operator's duplicates review tab.
//
// SAFE BY DEFAULT — dry run unless APPLY=true:
//   npx tsx src/scripts/merge-duplicate-externals.ts            # report only
//   APPLY=true npx tsx src/scripts/merge-duplicate-externals.ts # merge + index
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import mongoose, { type Model } from 'mongoose';
import { ExternalCandidateStatus } from '@shadchanai/shared';
import { env } from '../config/env.js';
import {
  ExternalCandidate,
  MatchSuggestion,
  PairScore,
  PairReview,
  Conversation,
  Task,
  type IExternalCandidate,
} from '../models/index.js';
import { buildIdentityKey, normalizeNamePart } from '../utils/identity.js';
import { isDuplicateKeyError } from '../utils/errors.js';
import { mergePhoneEntries, type PhoneEntry } from '../utils/phone.js';

const APPLY = process.env['APPLY'] === 'true';
// Opt-in: also merge single-first-name cards (no surname) that share the exact
// same first name + age. Off by default because two different people can share
// a common first name + age — enable only when you know the group is reposts.
const MERGE_SINGLE_NAME = process.env['MERGE_SINGLE_NAME'] === 'true';

// Collections that carry an externalCandidateId FK we must follow.
const REFERENCING: Array<{ name: string; model: Model<unknown> }> = [
  { name: 'MatchSuggestion', model: MatchSuggestion as unknown as Model<unknown> },
  { name: 'PairScore', model: PairScore as unknown as Model<unknown> },
  { name: 'PairReview', model: PairReview as unknown as Model<unknown> },
  { name: 'Conversation', model: Conversation as unknown as Model<unknown> },
  { name: 'Task', model: Task as unknown as Model<unknown> },
];

// Scalar fields safe to backfill onto the survivor when it's missing them.
const BACKFILL_FIELDS = [
  'gender', 'city', 'region', 'neighborhood', 'ethnicity', 'familyBackground',
  'height', 'sectorGroup', 'subSector', 'lifestyleTone', 'religiousStyle',
  'personalStatus', 'numberOfChildren', 'lifeStage', 'readinessForMarriage',
  'studyWorkDirection', 'currentOccupation', 'educationLevel', 'educationInstitution',
  'armyService', 'about', 'whatSeeking', 'additionalInfo', 'referenceName',
  'referencePhone', 'contactPhone', 'contactPhoneNormalized', 'photoUrl',
  'photoStorageKey', 'hebrewName', 'fatherName', 'motherName', 'email',
] as const;

/** Richness score — higher wins the survivor slot. */
function richness(c: IExternalCandidate): number {
  let n = 0;
  if (c.photoUrl || c.photoStorageKey) n += 5;
  for (const f of BACKFILL_FIELDS) {
    const v = (c as unknown as Record<string, unknown>)[f];
    if (v !== undefined && v !== null && v !== '') n += 1;
  }
  n += (c.sourceMessageIds?.length ?? 0);
  return n;
}

/** Re-point every referencing row from loser → survivor, dropping rows that
 *  would collide with an existing survivor row on a unique pair index. */
async function repointReferences(loserId: string, survivorId: string): Promise<Record<string, { moved: number; dropped: number }>> {
  const report: Record<string, { moved: number; dropped: number }> = {};
  for (const { name, model } of REFERENCING) {
    let moved = 0;
    let dropped = 0;
    const docs = await model.find({ externalCandidateId: loserId }).select('_id').lean().exec();
    for (const d of docs as Array<{ _id: mongoose.Types.ObjectId }>) {
      if (!APPLY) { moved += 1; continue; }
      try {
        await model.updateOne({ _id: d._id }, { $set: { externalCandidateId: survivorId } }).exec();
        moved += 1;
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          await model.deleteOne({ _id: d._id }).exec();
          dropped += 1;
        } else {
          throw err;
        }
      }
    }
    if (moved || dropped) report[name] = { moved, dropped };
  }
  return report;
}

async function mergeGroup(group: IExternalCandidate[]): Promise<void> {
  // Survivor: richest, then oldest.
  const ordered = [...group].sort((a, b) => {
    const r = richness(b) - richness(a);
    if (r !== 0) return r;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  const survivor = ordered[0]!;
  const losers = ordered.slice(1);

  const key = survivor.identityKey ?? buildIdentityKey(survivor.firstName, survivor.lastName, survivor.age);
  console.error(
    `\n▸ ${survivor.firstName ?? '?'} ${survivor.lastName ?? '?'} (age ${survivor.age ?? '?'})  key=${key}`,
  );
  console.error(`  survivor: ${survivor._id} (richness ${richness(survivor)})`);

  // Union source messages + backfill empty scalar fields from losers.
  const msgIds = new Set((survivor.sourceMessageIds ?? []).map(String));
  const surRec = survivor as unknown as Record<string, unknown>;
  // Every phone from every card in the group survives the merge — the
  // survivor keeps its primary contactPhone, but losers' DIFFERENT numbers
  // land in the labeled phones list instead of being discarded.
  const phonesOf = (c: IExternalCandidate, source: string): Array<{ number?: string | null; label?: string; source?: string }> => [
    ...(c.phones ?? []),
    ...(c.contactPhone ? [{ number: c.contactPhone, source }] : []),
    ...(c.referencePhone ? [{ number: c.referencePhone, label: c.referenceName || 'ממליץ/ה', source: 'reference' }] : []),
  ];
  let phones: PhoneEntry[] = mergePhoneEntries(undefined, phonesOf(survivor, 'card'));
  for (const loser of losers) {
    console.error(`  loser:    ${loser._id} (richness ${richness(loser)})`);
    phones = mergePhoneEntries(phones, phonesOf(loser, 'merged_card'));
    for (const id of loser.sourceMessageIds ?? []) msgIds.add(String(id));
    for (const f of BACKFILL_FIELDS) {
      const cur = surRec[f];
      const val = (loser as unknown as Record<string, unknown>)[f];
      if ((cur === undefined || cur === null || cur === '') && val !== undefined && val !== null && val !== '') {
        surRec[f] = val;
      }
    }
    if (loser.sourceImportedAt && loser.sourceImportedAt < survivor.sourceImportedAt) {
      survivor.sourceImportedAt = loser.sourceImportedAt;
    }
    const refs = await repointReferences(String(loser._id), String(survivor._id));
    if (Object.keys(refs).length) console.error(`    refs:   ${JSON.stringify(refs)}`);
  }
  survivor.sourceMessageIds = [...msgIds].map((s) => new mongoose.Types.ObjectId(s));
  if (phones.length) survivor.phones = phones;

  if (APPLY) {
    // Archive losers FIRST so the survivor's save (which sets identityKey via
    // the pre-save hook) can't collide with a still-active loser on the new
    // unique index.
    for (const loser of losers) {
      loser.archivedAt = new Date();
      loser.status = ExternalCandidateStatus.ARCHIVED;
      loser.staleReason = `merged_duplicate:${survivor._id}`;
      await loser.save();
    }
    await survivor.save();
  }
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  console.error(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  // ── 1. Backfill identityKey on every active candidate ──
  const active = await ExternalCandidate.find({ archivedAt: { $exists: false } }).exec();
  const groups = new Map<string, IExternalCandidate[]>();
  // Single-first-name (no surname) candidates, keyed by normalized first|age.
  const singleName = new Map<string, IExternalCandidate[]>();
  let keyed = 0;
  const bulk: Parameters<typeof ExternalCandidate.bulkWrite>[0] = [];
  for (const c of active) {
    const key = buildIdentityKey(c.firstName, c.lastName, c.age);
    if (key) {
      keyed += 1;
      if (c.identityKey !== key) {
        bulk.push({ updateOne: { filter: { _id: c._id }, update: { $set: { identityKey: key } } } });
        c.identityKey = key;
      }
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
    } else if (MERGE_SINGLE_NAME && c.firstName && !c.lastName && c.age) {
      const snKey = `${normalizeNamePart(c.firstName)}|${c.age}`;
      (singleName.get(snKey) ?? singleName.set(snKey, []).get(snKey)!).push(c);
    }
  }
  console.error(`Scanned ${active.length} active candidate(s); ${keyed} have a name+age identity key.`);
  if (APPLY && bulk.length) {
    await ExternalCandidate.bulkWrite(bulk);
    console.error(`Backfilled identityKey on ${bulk.length} candidate(s).`);
  }

  // ── 2. Merge groups with more than one active candidate ──
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  console.error(`\n${dupGroups.length} duplicate group(s) (same name + exact age).`);
  if (MERGE_SINGLE_NAME) {
    const snGroups = [...singleName.values()].filter((g) => g.length > 1);
    console.error(`${snGroups.length} single-first-name group(s) (same first name + exact age, no surname).`);
    dupGroups.push(...snGroups);
  }
  for (const g of dupGroups) await mergeGroup(g);

  // ── 3. Build the unique index (now that duplicates are gone) ──
  // Clear identityKey on archived docs first (they'd occupy the unique partial
  // index), then build ONLY the identityKey index directly — not
  // createIndexes(), which is all-or-nothing and would abort on any unrelated
  // index drift.
  if (APPLY) {
    const coll = ExternalCandidate.collection;
    const cleared = await coll.updateMany(
      { archivedAt: { $exists: true }, identityKey: { $exists: true } },
      { $unset: { identityKey: '' } },
    );
    console.error(`\nCleared identityKey on ${cleared.modifiedCount} archived candidate(s).`);
    console.error('Building identityKey unique index...');
    await coll.createIndex(
      { identityKey: 1 },
      { unique: true, partialFilterExpression: { identityKey: { $exists: true } }, name: 'identityKey_1' },
    );
    console.error('identityKey index built.');
  }

  console.error(
    APPLY
      ? `\nDone. Merged ${dupGroups.length} group(s).`
      : `\nDry run: no writes. Re-run with APPLY=true to merge ${dupGroups.length} group(s).`,
  );
  await mongoose.disconnect();
}

void main().catch((e) => {
  console.error('merge-duplicate-externals failed:', e);
  process.exit(1);
});
