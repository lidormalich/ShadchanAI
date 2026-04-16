// ═══════════════════════════════════════════════════════════
// Backfill: ownerUserId on legacy candidates / matches / tasks.
//
// Safe pre-pilot script. Never overwrites an existing
// ownerUserId. Resolves a fallback owner in priority order:
//
//   InternalCandidate:  first CREATE audit.performedBy → createdBy → FALLBACK_USER_ID
//   ExternalCandidate:  first CREATE audit.performedBy → importedBy → FALLBACK_USER_ID
//   MatchSuggestion:    first CREATE audit.performedBy → approvedBy → FALLBACK_USER_ID
//   Task:               first CREATE audit.performedBy → assignedTo → FALLBACK_USER_ID
//
// Usage (dry-run first, ALWAYS):
//   FALLBACK_USER_ID=<admin_user_id> DRY_RUN=true npx tsx src/scripts/backfill-owner.ts
//   FALLBACK_USER_ID=<admin_user_id>              npx tsx src/scripts/backfill-owner.ts
//
// FALLBACK_USER_ID is MANDATORY so a row never ends unowned.
// Suggested value: the id of the admin seeded by seed-admin.ts.
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import mongoose, { Types } from 'mongoose';
import { env } from '../config/env.js';
import {
  InternalCandidate,
  ExternalCandidate,
  MatchSuggestion,
  Task,
  AuditLog,
  User,
} from '../models/index.js';

const DRY_RUN = process.env['DRY_RUN'] === 'true';
const FALLBACK_RAW = process.env['FALLBACK_USER_ID'];

if (!FALLBACK_RAW || !Types.ObjectId.isValid(FALLBACK_RAW)) {
  console.error('FALLBACK_USER_ID env var is required and must be a valid ObjectId.');
  process.exit(2);
}
const FALLBACK = new Types.ObjectId(FALLBACK_RAW);

interface BackfillStats {
  scanned: number;
  alreadyOwned: number;
  filledFromAudit: number;
  filledFromField: number;
  filledFromFallback: number;
}

function empty(): BackfillStats {
  return { scanned: 0, alreadyOwned: 0, filledFromAudit: 0, filledFromField: 0, filledFromFallback: 0 };
}

async function firstCreateActor(entityType: string, entityId: Types.ObjectId): Promise<Types.ObjectId | null> {
  const row = await AuditLog.findOne({
    entityType,
    entityId,
    actionType: { $in: ['create'] },
  }).sort({ createdAt: 1 }).select('performedBy').lean().exec();
  if (!row?.performedBy) return null;
  if (!Types.ObjectId.isValid(String(row.performedBy))) return null;
  return new Types.ObjectId(String(row.performedBy));
}

async function backfillInternal(): Promise<BackfillStats> {
  const s = empty();
  const cursor = InternalCandidate.find({ ownerUserId: { $exists: false } })
    .select('_id createdBy').cursor();
  for await (const doc of cursor) {
    s.scanned += 1;
    const viaAudit = await firstCreateActor('internal_candidate', doc._id as Types.ObjectId);
    let owner = viaAudit;
    let source: keyof BackfillStats = 'filledFromAudit';
    if (!owner && doc.createdBy) { owner = doc.createdBy; source = 'filledFromField'; }
    if (!owner) { owner = FALLBACK; source = 'filledFromFallback'; }

    if (!DRY_RUN) {
      await InternalCandidate.updateOne(
        { _id: doc._id, ownerUserId: { $exists: false } },
        { $set: { ownerUserId: owner } },
      ).exec();
    }
    s[source] += 1;
  }
  s.alreadyOwned = await InternalCandidate.countDocuments({ ownerUserId: { $exists: true } }).exec();
  return s;
}

async function backfillExternal(): Promise<BackfillStats> {
  const s = empty();
  const cursor = ExternalCandidate.find({ ownerUserId: { $exists: false } })
    .select('_id importedBy').cursor();
  for await (const doc of cursor) {
    s.scanned += 1;
    const viaAudit = await firstCreateActor('external_candidate', doc._id as Types.ObjectId);
    let owner = viaAudit;
    let source: keyof BackfillStats = 'filledFromAudit';
    if (!owner && doc.importedBy) { owner = doc.importedBy; source = 'filledFromField'; }
    if (!owner) { owner = FALLBACK; source = 'filledFromFallback'; }

    if (!DRY_RUN) {
      await ExternalCandidate.updateOne(
        { _id: doc._id, ownerUserId: { $exists: false } },
        { $set: { ownerUserId: owner } },
      ).exec();
    }
    s[source] += 1;
  }
  s.alreadyOwned = await ExternalCandidate.countDocuments({ ownerUserId: { $exists: true } }).exec();
  return s;
}

async function backfillMatches(): Promise<BackfillStats> {
  // MatchSuggestion.ownerUserId is required in the schema, so rows
  // without it should not exist in normal operation. This handles
  // any edge case where it was unset via raw Mongo writes.
  const s = empty();
  const cursor = MatchSuggestion.find({ ownerUserId: { $exists: false } })
    .select('_id approvedBy').cursor();
  for await (const doc of cursor) {
    s.scanned += 1;
    const viaAudit = await firstCreateActor('match_suggestion', doc._id as Types.ObjectId);
    let owner = viaAudit;
    let source: keyof BackfillStats = 'filledFromAudit';
    if (!owner && doc.approvedBy) { owner = doc.approvedBy; source = 'filledFromField'; }
    if (!owner) { owner = FALLBACK; source = 'filledFromFallback'; }

    if (!DRY_RUN) {
      await MatchSuggestion.updateOne(
        { _id: doc._id, ownerUserId: { $exists: false } },
        { $set: { ownerUserId: owner } },
      ).exec();
    }
    s[source] += 1;
  }
  s.alreadyOwned = await MatchSuggestion.countDocuments({ ownerUserId: { $exists: true } }).exec();
  return s;
}

async function backfillTasks(): Promise<BackfillStats> {
  const s = empty();
  const cursor = Task.find({ ownerUserId: { $exists: false } })
    .select('_id assignedTo').cursor();
  for await (const doc of cursor) {
    s.scanned += 1;
    const viaAudit = await firstCreateActor('task', doc._id as Types.ObjectId);
    let owner = viaAudit;
    let source: keyof BackfillStats = 'filledFromAudit';
    if (!owner && doc.assignedTo) { owner = doc.assignedTo; source = 'filledFromField'; }
    if (!owner) { owner = FALLBACK; source = 'filledFromFallback'; }

    if (!DRY_RUN) {
      await Task.updateOne(
        { _id: doc._id, ownerUserId: { $exists: false } },
        { $set: { ownerUserId: owner } },
      ).exec();
    }
    s[source] += 1;
  }
  s.alreadyOwned = await Task.countDocuments({ ownerUserId: { $exists: true } }).exec();
  return s;
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  // Sanity: FALLBACK user must exist and be active.
  const u = await User.findById(FALLBACK).lean().exec();
  if (!u || !u.isActive) {
    console.error(`FALLBACK_USER_ID ${FALLBACK} is not an active user. Aborting.`);
    process.exit(3);
  }

  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY (writes enabled)'}`);
  console.log(`Fallback owner: ${u.name} <${u.email}>`);
  console.log('---');

  const [internals, externals, matches, tasks] = await Promise.all([
    backfillInternal(),
    backfillExternal(),
    backfillMatches(),
    backfillTasks(),
  ]);

  console.log('InternalCandidate:', internals);
  console.log('ExternalCandidate:', externals);
  console.log('MatchSuggestion:',   matches);
  console.log('Task:',              tasks);
  console.log('---');
  console.log(DRY_RUN
    ? 'Dry run complete. Re-run without DRY_RUN=true to apply.'
    : 'Backfill complete. Verify counts in the collection explorer.');

  await mongoose.disconnect();
}

void main().catch((e) => {
  console.error('backfill-owner failed:', e);
  process.exit(1);
});
