// ═══════════════════════════════════════════════════════════
// Verification pass — 3 real pairs + 3 real WhatsApp channels.
//
// Runs against the REAL configured MongoDB. Picks up to 3 active
// internal candidates of each gender and exercises the compatibility
// workspace; picks up to 3 channels and exercises the multi-account
// lock model. Prints a single structured report at the end.
//
// Read-only by default — never writes to the DB. Add WRITE=true if
// you want to additionally exercise a no-op PairReview upsert (it
// will be cleared at the end of the run).
//
// Usage:
//   npx tsx src/scripts/verification-pass.ts
//   PAIRS=3 CHANNELS=3 npx tsx src/scripts/verification-pass.ts
//   WRITE=true npx tsx src/scripts/verification-pass.ts
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import { connectDB, disconnectDB } from '../config/db.js';
import {
  InternalCandidate,
  ExternalCandidate,
  Channel,
  PairReview,
  type IInternalCandidate,
} from '../models/index.js';
import { Types } from 'mongoose';
import {
  buildBoardForInternal,
  checkPair,
  type CompatibilityBoard,
  type CompatibilityRow,
} from '../services/compatibility/compatibility.service.js';
import {
  describeAllSessions,
  hasLiveClient,
} from '../services/whatsapp/providers/baileys/baileys.client.js';
import {
  inspectChannelLock,
  INSTANCE_ID,
  STALE_MS,
  HEARTBEAT_INTERVAL_MS,
} from '../services/whatsapp/instance.lock.js';
import { upsertReview, clearReview } from '../modules/pair-reviews/pair-review.service.js';

const PAIR_LIMIT = Number(process.env['PAIRS'] ?? 3);
const CHANNEL_LIMIT = Number(process.env['CHANNELS'] ?? 3);
const WRITE = process.env['WRITE'] === 'true';

// ── Output helpers ────────────────────────────────────────

type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

interface Check {
  name: string;
  status: Status;
  detail?: string;
}

function fmtStatus(s: Status): string {
  switch (s) {
    case 'PASS': return '[PASS]';
    case 'WARN': return '[WARN]';
    case 'FAIL': return '[FAIL]';
    case 'SKIP': return '[SKIP]';
  }
}

function printSection(title: string): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' ' + title);
  console.log('═══════════════════════════════════════════════════════════');
}

function printCheck(c: Check): void {
  const detail = c.detail ? ' — ' + c.detail : '';
  console.log(`  ${fmtStatus(c.status)} ${c.name}${detail}`);
}

function summarizeRowOneLine(r: CompatibilityRow): string {
  const name = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || r.externalCandidateId.slice(-6);
  const score = typeof r.matchScore === 'number' ? r.matchScore : '—';
  const conf = typeof r.confidenceScore === 'number' ? r.confidenceScore : '—';
  return `${r.bucket.padEnd(10)} ${String(score).padStart(3)}/${String(conf).padStart(3)}  ${name.padEnd(28)}  ${r.explanation.primary.slice(0, 60)}`;
}

// ── Pair-level verification ───────────────────────────────

interface PairOutcome {
  internalId: string;
  internalName: string;
  externalsConsidered: number;
  totals: CompatibilityBoard['totals'];
  checks: Check[];
}

async function pickInternalCandidates(): Promise<IInternalCandidate[]> {
  // Prefer candidates with at least one opposite-gender external in pool;
  // we don't enforce that here because checking it requires the engine —
  // the verification itself is what surfaces empty-pool cases.
  const docs = await InternalCandidate.find({ status: 'active' })
    .sort({ updatedAt: -1 })
    .limit(PAIR_LIMIT * 3) // overfetch — we'll prefer ones with externals
    .exec();
  return docs;
}

function classifyInvariantChecks(board: CompatibilityBoard): Check[] {
  const out: Check[] = [];

  // 1. Bucket totals sum to row count
  const summed = board.totals.suitable + board.totals.blocked + board.totals.weak
    + board.totals.forced + board.totals.historical;
  out.push({
    name: 'totals sum to row count',
    status: summed === board.rows.length ? 'PASS' : 'FAIL',
    detail: `summed=${summed}, rows=${board.rows.length}`,
  });

  // 2. Suitable rows have score >= 70 AND confidence >= 60 AND eligible
  const badSuitable = board.rows.filter(
    (r) => r.bucket === 'suitable' && (
      !r.engineEligible
      || (typeof r.matchScore === 'number' && r.matchScore < 70)
      || (typeof r.confidenceScore === 'number' && r.confidenceScore < 60)
    ),
  );
  out.push({
    name: 'suitable rows meet score+confidence thresholds',
    status: badSuitable.length === 0 ? 'PASS' : 'FAIL',
    detail: badSuitable.length === 0 ? undefined : `${badSuitable.length} violations`,
  });

  // 3. Blocked rows are engine-ineligible AND have at least one blocker
  const badBlocked = board.rows.filter(
    (r) => r.bucket === 'blocked' && (r.engineEligible || r.blockers.length === 0),
  );
  out.push({
    name: 'blocked rows are engine-ineligible with blockers',
    status: badBlocked.length === 0 ? 'PASS' : 'FAIL',
    detail: badBlocked.length === 0 ? undefined : `${badBlocked.length} violations`,
  });

  // 4. Forceability matches blocker overridability
  const badForce = board.rows.filter((r) => {
    if (r.bucket !== 'blocked') return false;
    const anyNonOver = r.blockers.some((b) => b.overridable === 'none');
    const expected = anyNonOver ? 'none' : 'with_reason';
    return r.forceability !== expected;
  });
  out.push({
    name: 'blocked rows: forceability matches overridability',
    status: badForce.length === 0 ? 'PASS' : 'FAIL',
    detail: badForce.length === 0 ? undefined : `${badForce.length} violations`,
  });

  // 5. Forced rows actually carry forcedOverride=true
  const badForced = board.rows.filter(
    (r) => r.bucket === 'forced' && !r.forcedOverride,
  );
  out.push({
    name: 'forced rows actually carry forcedOverride=true',
    status: badForced.length === 0 ? 'PASS' : 'FAIL',
    detail: badForced.length === 0 ? undefined : `${badForced.length} violations`,
  });

  // 6. Historical rows have a terminal-state suggestion attached
  const HISTORICAL_STATUSES = new Set([
    'declined_side_a', 'declined_side_b', 'dating', 'closed', 'expired',
  ]);
  const badHist = board.rows.filter(
    (r) => r.bucket === 'historical'
      && (!r.matchStatus || !HISTORICAL_STATUSES.has(r.matchStatus)),
  );
  out.push({
    name: 'historical rows reference a terminal-state suggestion',
    status: badHist.length === 0 ? 'PASS' : 'FAIL',
    detail: badHist.length === 0 ? undefined : `${badHist.length} violations`,
  });

  // 7. Every row carries a deterministic explanation primary
  const noExplain = board.rows.filter((r) => !r.explanation?.primary?.trim());
  out.push({
    name: 'every row has a non-empty deterministic explanation',
    status: noExplain.length === 0 ? 'PASS' : 'FAIL',
    detail: noExplain.length === 0 ? undefined : `${noExplain.length} missing`,
  });

  // 8. Manual overlay implies a manualStatus
  const overlayMismatch = board.rows.filter(
    (r) => r.explanation.manualOverlay && !r.manualStatus,
  );
  out.push({
    name: 'manual overlay only when manualStatus is set',
    status: overlayMismatch.length === 0 ? 'PASS' : 'FAIL',
    detail: overlayMismatch.length === 0 ? undefined : `${overlayMismatch.length} mismatches`,
  });

  return out;
}

async function verifyPair(internal: IInternalCandidate): Promise<PairOutcome> {
  const internalId = String(internal._id);
  const internalName = `${internal.firstName} ${internal.lastName}`;
  const board = await buildBoardForInternal(internalId, 'strict');
  const checks: Check[] = [
    {
      name: 'compatibility board built without throwing',
      status: 'PASS',
      detail: `${board.rows.length} rows, ${board.externalsConsidered} externals considered`,
    },
    ...classifyInvariantChecks(board),
  ];

  // 9. Round-trip: pick one suitable row and confirm checkPair agrees
  const sample = board.rows.find((r) => r.bucket === 'suitable')
    ?? board.rows.find((r) => r.bucket === 'weak')
    ?? board.rows.find((r) => r.bucket === 'blocked')
    ?? board.rows[0];
  if (sample) {
    const single = await checkPair(internalId, sample.externalCandidateId, 'strict');
    const sameBucket = single.bucket === sample.bucket;
    const sameForce = single.forceability === sample.forceability;
    checks.push({
      name: 'checkPair agrees with board for sample row',
      status: sameBucket && sameForce ? 'PASS' : 'FAIL',
      detail: `bucket: board=${sample.bucket} pair=${single.bucket}; force: board=${sample.forceability} pair=${single.forceability}`,
    });
  } else {
    checks.push({ name: 'checkPair agreement', status: 'SKIP', detail: 'no rows on board' });
  }

  // 10. WRITE mode: upsert a manual review then clear it
  if (WRITE && sample) {
    try {
      await upsertReview({
        internalCandidateId: internalId,
        externalCandidateId: sample.externalCandidateId,
        manualStatus: 'review_later',
        operatorReason: '[verification-pass] auto round-trip',
        performedBy: '000000000000000000000001',
      });
      const after = await PairReview.findOne({
        internalCandidateId: new Types.ObjectId(internalId),
        externalCandidateId: new Types.ObjectId(sample.externalCandidateId),
      }).exec();
      const ok = !!after && after.manualStatus === 'review_later';
      checks.push({
        name: 'WRITE: PairReview upsert round-trip',
        status: ok ? 'PASS' : 'FAIL',
        detail: ok ? 'cleared after verify' : 'review row missing or wrong status',
      });
      // Always clear so the run leaves no trace.
      try {
        await clearReview(internalId, sample.externalCandidateId, '000000000000000000000001');
      } catch {
        // tolerate already-cleared
      }
    } catch (e) {
      checks.push({
        name: 'WRITE: PairReview upsert round-trip',
        status: 'FAIL',
        detail: (e as Error).message,
      });
    }
  } else if (WRITE) {
    checks.push({ name: 'WRITE: PairReview upsert round-trip', status: 'SKIP', detail: 'no sample row' });
  }

  return {
    internalId,
    internalName,
    externalsConsidered: board.externalsConsidered,
    totals: board.totals,
    checks,
  };
}

// ── Channel-level verification ────────────────────────────

interface ChannelOutcome {
  channelId: string;
  accountDisplayName: string;
  status: string;
  hasLiveClient: boolean;
  liveState: string | null;
  lockOwner: string | null;
  lockAgeMs: number | null;
  lockIsStale: boolean;
  lockIsOurs: boolean;
  checks: Check[];
}

async function verifyChannel(c: { channelId: string; accountDisplayName: string; status: string }): Promise<ChannelOutcome> {
  const checks: Check[] = [];
  const lock = await inspectChannelLock(c.channelId);
  const live = hasLiveClient(c.channelId);

  // 1. Live client implies we own the lock
  if (live) {
    checks.push({
      name: 'live client → owns the lock',
      status: lock.isOurs ? 'PASS' : 'FAIL',
      detail: lock.isOurs ? undefined : `lock owner is ${lock.ownerInstanceId ?? 'null'}, not us (${INSTANCE_ID})`,
    });
  } else {
    checks.push({ name: 'live client → owns the lock', status: 'SKIP', detail: 'no live client in this process' });
  }

  // 2. Owned-and-not-stale lock implies fresh heartbeat
  if (lock.ownerInstanceId && !lock.isStale) {
    const ageOk = lock.ageMs !== null && lock.ageMs < HEARTBEAT_INTERVAL_MS * 4;
    checks.push({
      name: 'fresh lock heartbeat is recent',
      status: ageOk ? 'PASS' : 'WARN',
      detail: lock.ageMs === null
        ? 'no heartbeat timestamp'
        : `age=${Math.round(lock.ageMs / 1000)}s (heartbeat interval=${HEARTBEAT_INTERVAL_MS / 1000}s)`,
    });
  } else if (!lock.ownerInstanceId) {
    checks.push({ name: 'fresh lock heartbeat is recent', status: 'SKIP', detail: 'lock not held' });
  } else {
    checks.push({
      name: 'fresh lock heartbeat is recent',
      status: 'WARN',
      detail: `lock is stale (age=${Math.round((lock.ageMs ?? 0) / 1000)}s, threshold=${STALE_MS / 1000}s) — operator should force-release if owner is dead`,
    });
  }

  // 3. Stale lock can only be reclaimed by another acquire — sanity check
  //    that "isStale" is consistent with the threshold.
  if (lock.ownerInstanceId && lock.ageMs !== null) {
    const expectedStale = lock.ageMs > STALE_MS;
    checks.push({
      name: 'isStale consistent with age and STALE_MS',
      status: lock.isStale === expectedStale ? 'PASS' : 'FAIL',
      detail: `age=${lock.ageMs}ms, isStale=${lock.isStale}, expected=${expectedStale}`,
    });
  }

  // 4. ACTIVE channel SHOULD either have a live client or have its
  //    lock free / stale (so it could be started). A no-live + fresh
  //    foreign lock is a real cross-process conflict.
  if (c.status === 'active') {
    if (live) {
      checks.push({ name: 'active channel: live in this process', status: 'PASS' });
    } else if (!lock.ownerInstanceId || lock.isStale) {
      checks.push({
        name: 'active channel without live client: lock is reclaimable',
        status: 'PASS',
        detail: lock.ownerInstanceId ? `holder=${lock.ownerInstanceId} (stale)` : 'no holder',
      });
    } else {
      checks.push({
        name: 'active channel without live client: lock is reclaimable',
        status: 'WARN',
        detail: `held by ${lock.ownerInstanceId} (age=${Math.round((lock.ageMs ?? 0) / 1000)}s) — different process owns this channel`,
      });
    }
  }

  // 5. Inert channel (disconnected/suspended/replaced) MUST NOT have a
  //    live client in this process.
  if (['disconnected', 'suspended', 'replaced'].includes(c.status)) {
    checks.push({
      name: 'inert channel has no live client',
      status: live ? 'FAIL' : 'PASS',
      detail: live ? 'a Baileys client is still registered for an inert channel' : undefined,
    });
  }

  return {
    channelId: c.channelId,
    accountDisplayName: c.accountDisplayName,
    status: c.status,
    hasLiveClient: live,
    liveState: lock.isOurs ? (await describeAllSessions()).find((s) => s.channelId === c.channelId)?.state ?? null : null,
    lockOwner: lock.ownerInstanceId,
    lockAgeMs: lock.ageMs,
    lockIsStale: lock.isStale,
    lockIsOurs: lock.isOurs,
    checks,
  };
}

// ── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();
  await connectDB();

  console.log(JSON.stringify({
    event: 'verification_pass_start',
    instanceId: INSTANCE_ID,
    pairLimit: PAIR_LIMIT,
    channelLimit: CHANNEL_LIMIT,
    writeMode: WRITE,
  }));

  // ── Pairs ───────────────────────────────────────────────
  printSection(`PAIRS (up to ${PAIR_LIMIT} real internal candidates)`);
  const candidates = await pickInternalCandidates();
  const pairOutcomes: PairOutcome[] = [];
  if (candidates.length === 0) {
    console.log('  [SKIP] No active internal candidates in DB.');
  } else {
    let processed = 0;
    for (const c of candidates) {
      if (processed >= PAIR_LIMIT) break;
      try {
        const out = await verifyPair(c);
        if (out.externalsConsidered === 0 && processed === 0) {
          // Soft note — try a few more to find one with externals.
          console.log(`  (skipping ${out.internalName}: no externals in pool)`);
          continue;
        }
        processed += 1;
        console.log('');
        console.log(` --- ${out.internalName} (${out.internalId.slice(-6)}) ---`);
        console.log(`     totals: suitable=${out.totals.suitable} weak=${out.totals.weak} blocked=${out.totals.blocked} forced=${out.totals.forced} historical=${out.totals.historical}`);
        for (const ch of out.checks) printCheck(ch);
        // Top 3 rows preview
        const board = await buildBoardForInternal(out.internalId, 'strict');
        const preview = board.rows.slice(0, 3);
        if (preview.length > 0) {
          console.log('     sample rows:');
          for (const r of preview) console.log('       ' + summarizeRowOneLine(r));
        }
        pairOutcomes.push(out);
      } catch (e) {
        processed += 1;
        console.log('');
        console.log(` --- ${c.firstName} ${c.lastName} (${String(c._id).slice(-6)}) ---`);
        printCheck({ name: 'compatibility board built without throwing', status: 'FAIL', detail: (e as Error).message });
      }
    }
  }

  // ── Channels ────────────────────────────────────────────
  printSection(`CHANNELS (up to ${CHANNEL_LIMIT} real WhatsApp channels)`);
  const channels = await Channel.find({})
    .sort({ createdAt: 1 })
    .limit(CHANNEL_LIMIT)
    .exec();
  const channelOutcomes: ChannelOutcome[] = [];
  if (channels.length === 0) {
    console.log('  [SKIP] No channels in DB.');
  } else {
    for (const c of channels) {
      const out = await verifyChannel({
        channelId: c.channelId,
        accountDisplayName: c.accountDisplayName,
        status: c.status,
      });
      channelOutcomes.push(out);
      console.log('');
      console.log(` --- ${out.accountDisplayName} (${out.channelId}) ---`);
      console.log(`     status=${out.status}  liveClient=${out.hasLiveClient}  liveState=${out.liveState ?? '—'}`);
      console.log(`     lock: owner=${out.lockOwner ?? '—'}  age=${out.lockAgeMs == null ? '—' : Math.round(out.lockAgeMs / 1000) + 's'}  stale=${out.lockIsStale}  ours=${out.lockIsOurs}`);
      for (const ch of out.checks) printCheck(ch);
    }
  }

  // ── Cross-channel lock invariant ────────────────────────
  printSection('CROSS-CHANNEL LOCK INVARIANTS');
  const allSessions = await describeAllSessions();
  const conflictingFresh = allSessions.filter(
    (s) => s.lock.ownerInstanceId
      && s.lock.ownerInstanceId !== INSTANCE_ID
      && !s.lock.isStale,
  );
  printCheck({
    name: 'no fresh foreign lock without a live local client',
    status: conflictingFresh.length === 0 ? 'PASS' : 'WARN',
    detail: conflictingFresh.length === 0
      ? undefined
      : `${conflictingFresh.length} channels held by another live process — expected only if you actually run multiple instances`,
  });
  const ownedNoLive = allSessions.filter(
    (s) => s.lock.isOurs && !s.hasLiveClient,
  );
  printCheck({
    name: 'no leaked lock: every lock we own has a live client',
    status: ownedNoLive.length === 0 ? 'PASS' : 'FAIL',
    detail: ownedNoLive.length === 0
      ? undefined
      : `${ownedNoLive.length} channels: ${ownedNoLive.map((s) => s.channelId).join(', ')}`,
  });

  // ── Summary ─────────────────────────────────────────────
  printSection('SUMMARY');
  const allChecks = [
    ...pairOutcomes.flatMap((o) => o.checks),
    ...channelOutcomes.flatMap((o) => o.checks),
  ];
  const counts: Record<Status, number> = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
  for (const c of allChecks) counts[c.status] += 1;
  console.log(`  pairs verified:    ${pairOutcomes.length}`);
  console.log(`  channels verified: ${channelOutcomes.length}`);
  console.log(`  PASS: ${counts.PASS}   WARN: ${counts.WARN}   FAIL: ${counts.FAIL}   SKIP: ${counts.SKIP}`);
  console.log(`  duration: ${Math.round((Date.now() - startedAt) / 100) / 10}s`);

  await disconnectDB();

  // Exit non-zero on any FAIL so a CI runner can gate on it.
  process.exit(counts.FAIL > 0 ? 1 : 0);
}

void main().catch(async (err) => {
  console.error('verification-pass crashed:', err);
  try { await disconnectDB(); } catch { /* best-effort */ }
  process.exit(2);
});
