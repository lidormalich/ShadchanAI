// ═══════════════════════════════════════════════════════════
// Backfill: populate ExternalCandidate.contactPhoneNormalized
// from ExternalCandidate.contactPhone, and report duplicates.
//
// This script is STRICTLY non-destructive:
//   - never overwrites a non-empty contactPhoneNormalized
//   - never deletes or merges any candidate
//   - only produces a duplicates report the operator decides on
//
// Usage:
//   DRY_RUN=true npx tsx src/scripts/backfill-phones.ts
//                npx tsx src/scripts/backfill-phones.ts
//
// Output:
//   - console summary (filled / skipped / invalid)
//   - duplicates printed as JSON lines so they can be diverted
//     into a file for manual review:
//       npx tsx src/scripts/backfill-phones.ts > dup-report.ndjson
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { ExternalCandidate } from '../models/index.js';
import { normalizePhone } from '../utils/phone.js';

const DRY_RUN = process.env['DRY_RUN'] === 'true';

interface FillStats {
  scanned: number;
  alreadyNormalized: number;
  filled: number;
  rawMissing: number;
  invalid: number;
}

async function fillNormalized(): Promise<FillStats> {
  const s: FillStats = { scanned: 0, alreadyNormalized: 0, filled: 0, rawMissing: 0, invalid: 0 };
  const cursor = ExternalCandidate.find({}).select('_id contactPhone contactPhoneNormalized').cursor();
  for await (const doc of cursor) {
    s.scanned += 1;
    if (doc.contactPhoneNormalized) { s.alreadyNormalized += 1; continue; }
    if (!doc.contactPhone) { s.rawMissing += 1; continue; }

    const canon = normalizePhone(doc.contactPhone);
    if (!canon) { s.invalid += 1; continue; }

    if (!DRY_RUN) {
      await ExternalCandidate.updateOne(
        { _id: doc._id, contactPhoneNormalized: { $exists: false } },
        { $set: { contactPhoneNormalized: canon } },
      ).exec();
    }
    s.filled += 1;
  }
  return s;
}

interface DuplicateGroup {
  normalizedPhone: string;
  count: number;
  candidates: Array<{
    id: string;
    firstName?: string;
    lastName?: string;
    status: string;
    availabilityStatus?: string;
    archivedAt?: Date;
    createdAt: Date;
  }>;
}

async function reportDuplicates(): Promise<DuplicateGroup[]> {
  const agg = await ExternalCandidate.aggregate<{
    _id: string;
    count: number;
    candidates: Array<{
      id: mongoose.Types.ObjectId;
      firstName?: string;
      lastName?: string;
      status: string;
      availabilityStatus?: string;
      archivedAt?: Date;
      createdAt: Date;
    }>;
  }>([
    { $match: { contactPhoneNormalized: { $exists: true, $ne: null } } },
    { $group: {
        _id: '$contactPhoneNormalized',
        count: { $sum: 1 },
        candidates: { $push: {
          id: '$_id',
          firstName: '$firstName',
          lastName: '$lastName',
          status: '$status',
          availabilityStatus: '$availabilityStatus',
          archivedAt: '$archivedAt',
          createdAt: '$createdAt',
        } },
    } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]).exec();

  return agg.map((g) => ({
    normalizedPhone: g._id,
    count: g.count,
    candidates: g.candidates.map((c) => ({
      id: String(c.id),
      firstName: c.firstName,
      lastName: c.lastName,
      status: c.status,
      availabilityStatus: c.availabilityStatus,
      archivedAt: c.archivedAt,
      createdAt: c.createdAt,
    })),
  }));
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);

  console.error(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);
  console.error('--- Fill contactPhoneNormalized ---');
  const fill = await fillNormalized();
  console.error(JSON.stringify(fill, null, 2));

  console.error('--- Duplicate report (JSON lines to stdout) ---');
  const dups = await reportDuplicates();
  for (const g of dups) {
    process.stdout.write(JSON.stringify(g) + '\n');
  }
  console.error(`${dups.length} duplicate group(s) found.`);
  console.error('Review each group and either archive the duplicate or merge manually.');
  console.error(DRY_RUN
    ? 'Dry run: no writes were performed.'
    : 'Normalization applied; duplicates NOT auto-merged by design.');

  await mongoose.disconnect();
}

void main().catch((e) => {
  console.error('backfill-phones failed:', e);
  process.exit(1);
});
