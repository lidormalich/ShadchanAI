// ═══════════════════════════════════════════════════════════
// ShadchanAI — Incremental Match Scan
//
// Scans internal × external candidate pairs and caches the engine
// score for each in the PairScore collection. Three modes:
//   • missing      — only score pairs never scored before (fill gaps).
//                    If X was already scored against Z, X-Z is skipped;
//                    a brand-new pair X-Y is scored. This is the default
//                    for the operator "סרוק הצעות" button.
//   • incremental  — score new pairs AND pairs where a candidate's
//                    engine-relevant fields changed since last scan
//                    (via scoringHash). Used by the hourly job.
//   • full         — re-score everything.
//
// Scans run in the BACKGROUND (startScan) so the UI can show live
// progress in a minimizable modal; progress is written to MatchScanState
// and polled by the client. A module-level lock prevents overlap.
//
// For eligible pairs above the (operator-configurable) auto-create
// threshold, a draft MatchSuggestion is created automatically, owned by
// the internal candidate's shadchan. Thresholds live in Settings
// (matching.scan_*). The pure engine is never modified.
// ═══════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { SourceMode } from '@shadchanai/shared';
import {
  InternalCandidate,
  ExternalCandidate,
  MatchSuggestion,
  PairScore,
  MatchScanState,
  PairReview,
  User,
} from '../../models/index.js';
import { evaluatePair as engineEvaluatePair } from './matching.engine.js';
import {
  toMatchableInternal,
  toMatchableExternal,
  buildEngineContext,
} from './matchable.mapper.js';
import { SUITABLE_SCORE_MIN, SUITABLE_CONFIDENCE_MIN } from './matching.constants.js';
import {
  getSettingNumber,
  getSettingBoolean,
} from '../../modules/settings/settings.service.js';
import { ConflictError } from '../../utils/errors.js';
import type { MatchableInternal, MatchableExternal, MatchingContext } from './matching.types.js';
import type { PairScoreBucket, ScoreDirection, ScanMode, ScanStatus } from '../../modules/matches/pair-score.model.js';

// Dependency inversion: the scan lives in services/ but auto-creates
// draft suggestions, whose canonical creator (createManualSuggestion)
// lives UP in modules/matches. To honour the modules→services flow we
// do NOT statically import it; callers inject it via ScanOpts.create-
// Suggestion. The default below lazy-imports it only when a caller (the
// hourly background job) omits the dependency — a single, documented
// dynamic seam so the STATIC module graph still points modules→services.
export type CreateSuggestionFn = (
  internalId: string,
  externalId: string,
  mode: SourceMode,
  performedBy: string,
) => Promise<{ _id: unknown }>;

async function defaultCreateSuggestion(
  internalId: string,
  externalId: string,
  mode: SourceMode,
  performedBy: string,
): Promise<{ _id: unknown }> {
  const { createManualSuggestion } = await import('../../modules/matches/match.service.js');
  return createManualSuggestion(internalId, externalId, mode, performedBy);
}

// Safety caps so a first full scan (or a misconfiguration) cannot run
// unbounded inside the in-process scheduler.
const MAX_PAIRS_PER_SCAN = 50_000;
const MAX_AUTO_CREATES_PER_SCAN = 500;
const PROGRESS_EVERY = 25;

// Only one scan may run at a time (single-instance server).
let scanInFlight = false;

interface ScanOpts {
  trigger: 'manual' | 'job';
  /** User triggering a manual scan; fallback owner for auto-created drafts. */
  performedBy?: string;
  mode?: ScanMode;
  /**
   * Injected creator for auto-created draft suggestions (dependency
   * inversion — see CreateSuggestionFn). Omit to use the lazy default.
   */
  createSuggestion?: CreateSuggestionFn;
}

export interface ScanSummary {
  internalsConsidered: number;
  externalsConsidered: number;
  pairsScored: number;
  pairsSkipped: number;
  draftsCreated: number;
  improved: number;
  declined: number;
  durationMs: number;
  truncated: boolean;
  lastScanAt: string;
}

export interface ScanStateView {
  status: ScanStatus;
  mode: ScanMode;
  running: boolean;
  progressCurrent: number;
  progressTotal: number;
  internalsConsidered: number;
  externalsConsidered: number;
  pairsScored: number;
  pairsSkipped: number;
  draftsCreated: number;
  improved: number;
  declined: number;
  durationMs: number;
  lastScanAt?: string;
  lastError?: string;
}

// ── Scoring-hash helpers ──────────────────────────────────
// Stable hash over the fields that actually feed the engine. Fields are
// serialized in a FIXED order so the hash is deterministic. Anything not
// listed here (e.g. free-text notes, photos) does NOT trigger a re-scan.

function hashOf(parts: unknown[]): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}

function internalScoringHash(m: MatchableInternal): string {
  return hashOf([
    m.gender, m.dateOfBirth, m.city, m.region, m.ethnicity, m.height,
    m.childrenPreference, m.careerPriority,
    m.sectorGroup, m.subSector, m.lifestyleTone, m.religiousStyle,
    m.personalStatus, m.numberOfChildren, m.lifeStage, m.readinessForMarriage,
    m.studyWorkDirection, m.hardConstraints, m.softPreferences,
    m.agePreferences, m.locationPreferences, m.openness,
    m.status, m.sendReadinessBlockers, m.datingPartnerCandidateId,
    m.profileCompletion, m.lastVerifiedAt,
  ]);
}

function externalScoringHash(m: MatchableExternal): string {
  return hashOf([
    m.gender, m.age, m.city, m.region, m.ethnicity, m.height,
    m.childrenPreference, m.careerPriority,
    m.sectorGroup, m.subSector, m.lifestyleTone,
    m.personalStatus, m.lifeStage, m.studyWorkDirection,
    m.availabilityStatus, m.status,
    m.hardConstraints, m.softPreferences, m.agePreferences,
    m.locationPreferences, m.openness, m.ageReliability, m.staleAt,
  ]);
}

function bucketOf(eligible: boolean, matchScore: number, confidenceScore: number): PairScoreBucket {
  if (!eligible) return 'blocked';
  if (matchScore >= SUITABLE_SCORE_MIN && confidenceScore >= SUITABLE_CONFIDENCE_MIN) return 'suitable';
  return 'weak';
}

/**
 * Resolve the owner to attribute auto-created drafts to when the internal
 * candidate itself has no owner. A manual scan passes the triggering user
 * (performedBy); the background job has none, so without a fallback,
 * unowned candidates would NEVER get drafts from the auto-scan. We fall
 * back to the first active admin (then any active user) so background
 * scans still surface drafts. Returns undefined only if there are no
 * active users at all (drafts are then skipped, as before).
 */
async function resolveFallbackOwner(performedBy?: string): Promise<string | undefined> {
  if (performedBy) return performedBy;
  const admin = await User.findOne({ isActive: true, roles: 'admin' })
    .select('_id').sort({ createdAt: 1 }).lean().exec();
  if (admin) return String(admin._id);
  const anyUser = await User.findOne({ isActive: true })
    .select('_id').sort({ createdAt: 1 }).lean().exec();
  return anyUser ? String(anyUser._id) : undefined;
}

// ── Public entry points ───────────────────────────────────

/**
 * Kick off a scan in the background. Returns immediately; progress is
 * written to MatchScanState and can be polled via getScanState(). If a
 * scan is already running, this is a no-op that reports the live state.
 */
export async function startScan(opts: ScanOpts): Promise<{ started: boolean; state: ScanStateView | null }> {
  if (scanInFlight) {
    return { started: false, state: await getScanState() };
  }
  scanInFlight = true;
  const mode: ScanMode = opts.mode ?? 'missing';
  await setRunningState(mode, opts.trigger);
  void executeScan({ ...opts, mode })
    .catch(async (e) => {
      try {
        await MatchScanState.updateOne(
          { singleton: 'match-scan' },
          { $set: { status: 'error', lastError: String((e as Error)?.message ?? e) } },
        ).exec();
      } catch { /* ignore */ }
    })
    .finally(() => { scanInFlight = false; });
  return { started: true, state: await getScanState() };
}

/**
 * Run a scan and await completion (used by the background job). Returns
 * null if a scan is already in flight.
 */
export async function runScanNow(opts: ScanOpts): Promise<ScanSummary | null> {
  if (scanInFlight) return null;
  scanInFlight = true;
  const mode: ScanMode = opts.mode ?? 'incremental';
  try {
    await setRunningState(mode, opts.trigger);
    return await executeScan({ ...opts, mode });
  } catch (e) {
    await MatchScanState.updateOne(
      { singleton: 'match-scan' },
      { $set: { status: 'error', lastError: String((e as Error)?.message ?? e) } },
    ).exec();
    throw e;
  } finally {
    scanInFlight = false;
  }
}

async function setRunningState(mode: ScanMode, trigger: 'manual' | 'job'): Promise<void> {
  await MatchScanState.findOneAndUpdate(
    { singleton: 'match-scan' },
    {
      $set: {
        status: 'running',
        mode,
        lastTrigger: trigger,
        progressCurrent: 0,
        progressTotal: 0,
        startedAt: new Date(),
        lastError: null,
      },
    },
    { upsert: true },
  ).exec();
}

// ── Core worker ───────────────────────────────────────────

async function executeScan(opts: ScanOpts & { mode: ScanMode }): Promise<ScanSummary> {
  const startedAt = Date.now();
  const engineMode = SourceMode.DISCOVERY;
  const mode = opts.mode;
  const createSuggestion = opts.createSuggestion ?? defaultCreateSuggestion;

  const [scanMinScore, autoEnabled, autoMinScore, fallbackOwner] = await Promise.all([
    getSettingNumber('matching.scan_min_score'),
    getSettingBoolean('matching.scan_autocreate_enabled'),
    getSettingNumber('matching.scan_autocreate_min_score'),
    resolveFallbackOwner(opts.performedBy),
  ]);

  const [internals, externals] = await Promise.all([
    InternalCandidate.find({ status: 'active', archivedAt: { $exists: false } })
      .select(
        'firstName lastName gender dateOfBirth city region ethnicity lifeGoals height sectorGroup subSector ' +
        'lifestyleTone religiousStyle personalStatus numberOfChildren lifeStage ' +
        'readinessForMarriage studyWorkDirection hardConstraints softPreferences ' +
        'agePreferences locationPreferences openness profileCompletion ' +
        'missingCriticalFields sendReadinessBlockers profileQualityScore ' +
        'dataReliabilityScore readinessScore status lastVerifiedAt lastActionAt ' +
        'datingPartnerCandidateId deferredSuggestionsCount scoringHash ownerUserId',
      )
      .lean()
      .exec(),
    ExternalCandidate.find({
      status: 'active',
      archivedAt: { $exists: false },
      availabilityStatus: { $in: ['available', 'unknown'] },
    })
      .select(
        'firstName lastName gender age city region ethnicity lifeGoals height sectorGroup subSector ' +
        'lifestyleTone personalStatus lifeStage studyWorkDirection ' +
        'availabilityStatus status shareCard ageReliability hardConstraints ' +
        'softPreferences agePreferences locationPreferences openness staleAt ' +
        'lastConfirmedAvailableAt lastSourceUpdateAt sourceImportedAt scoringHash',
      )
      .lean()
      .exec(),
  ]);

  const internalRows = internals.map((doc) => {
    const m = toMatchableInternal(doc as Record<string, unknown>);
    const hash = internalScoringHash(m);
    const dirty = mode === 'full' || (doc as { scoringHash?: string }).scoringHash !== hash;
    return { m, hash, dirty, ownerUserId: (doc as { ownerUserId?: Types.ObjectId }).ownerUserId };
  });
  const externalRows = externals.map((doc) => {
    const m = toMatchableExternal(doc as Record<string, unknown>);
    const hash = externalScoringHash(m);
    const dirty = mode === 'full' || (doc as { scoringHash?: string }).scoringHash !== hash;
    return { m, hash, dirty };
  });

  // Preload existing PairScore rows for these internals → previousScore.
  const internalIds = internalRows.map((r) => new Types.ObjectId(r.m._id));
  const existing = await PairScore.find({ internalCandidateId: { $in: internalIds } })
    .select('internalCandidateId externalCandidateId matchScore')
    .lean()
    .exec();
  const prevByPair = new Map<string, number>();
  for (const row of existing) {
    const key = `${String(row.internalCandidateId)}:${String(row.externalCandidateId)}`;
    prevByPair.set(key, row.matchScore);
  }

  // "missing" mode = pairs that do NOT yet have an active suggestion.
  // (NOT "no PairScore row": a pair may have been scored before without
  // producing a suggestion — e.g. scored by the owner-less hourly job —
  // and must still get a chance to become a draft.)
  const suggestedKeys = new Set<string>();
  if (mode === 'missing') {
    const active = await MatchSuggestion.find({
      internalCandidateId: { $in: internalIds },
      status: { $nin: ['closed', 'expired'] },
    }).select('internalCandidateId externalCandidateId').lean().exec();
    for (const s of active) {
      suggestedKeys.add(`${String(s.internalCandidateId)}:${String(s.externalCandidateId)}`);
    }
  }

  // ── Build the work-list (so progressTotal is exact) ──────
  type IR = (typeof internalRows)[number];
  type ER = (typeof externalRows)[number];
  const work: Array<{ ir: IR; er: ER; pairKey: string }> = [];
  let pairsSkipped = 0;
  let truncated = false;

  for (const ir of internalRows) {
    const internalGender = ir.m.gender;
    if (!internalGender) continue;
    const oppositeGender = internalGender === 'male' ? 'female' : 'male';
    for (const er of externalRows) {
      if (er.m.gender !== oppositeGender) continue;
      const pairKey = `${ir.m._id}:${er.m._id}`;
      const include = mode === 'missing'
        ? !suggestedKeys.has(pairKey)
        : (mode === 'full' || ir.dirty || er.dirty);
      if (!include) { pairsSkipped++; continue; }
      if (work.length >= MAX_PAIRS_PER_SCAN) { truncated = true; continue; }
      work.push({ ir, er, pairKey });
    }
  }

  await MatchScanState.updateOne(
    { singleton: 'match-scan' },
    { $set: { progressTotal: work.length, progressCurrent: 0 } },
  ).exec();

  // ── Score each work item ─────────────────────────────────
  const ctxCache = new Map<string, MatchingContext>();
  const pairOps: Parameters<typeof PairScore.bulkWrite>[0] = [];
  const touchedInternal = new Set<string>();
  const touchedExternal = new Set<string>();

  let pairsScored = 0;
  let draftsCreated = 0;
  let improved = 0;
  let declined = 0;

  for (const { ir, er, pairKey } of work) {
    let ctx = ctxCache.get(ir.m._id);
    if (!ctx) {
      ctx = await buildEngineContext(ir.m._id, engineMode);
      ctxCache.set(ir.m._id, ctx);
    }

    const r = engineEvaluatePair(ir.m, er.m, ctx);
    pairsScored++;
    touchedInternal.add(ir.m._id);
    touchedExternal.add(er.m._id);

    const previousScore = prevByPair.get(pairKey);
    let direction: ScoreDirection = 'new';
    let delta = 0;
    if (previousScore !== undefined) {
      delta = r.matchScore - previousScore;
      direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'same';
      if (delta > 0) improved++;
      else if (delta < 0) declined++;
    }

    // Auto-create a draft for strong, eligible pairs.
    let matchSuggestionId: Types.ObjectId | undefined;
    let autoCreated = false;
    const ownerId = ir.ownerUserId ? String(ir.ownerUserId) : fallbackOwner;
    if (
      autoEnabled &&
      r.eligible &&
      r.matchScore >= autoMinScore &&
      r.matchScore >= scanMinScore &&
      ownerId &&
      draftsCreated < MAX_AUTO_CREATES_PER_SCAN
    ) {
      try {
        const doc = await createSuggestion(ir.m._id, er.m._id, engineMode, ownerId);
        matchSuggestionId = doc._id as Types.ObjectId;
        autoCreated = true;
        draftsCreated++;
      } catch (e) {
        if (e instanceof ConflictError) {
          const found = await MatchSuggestion.findOne({
            internalCandidateId: new Types.ObjectId(ir.m._id),
            externalCandidateId: new Types.ObjectId(er.m._id),
            status: { $nin: ['closed', 'expired'] },
          }).select('_id').lean().exec();
          if (found) matchSuggestionId = found._id as Types.ObjectId;
        }
        // BusinessRuleError (ineligible) → just record the score row.
      }
    }

    const set: Record<string, unknown> = {
      internalHash: ir.hash,
      externalHash: er.hash,
      mode: engineMode,
      eligible: r.eligible,
      matchScore: r.matchScore,
      confidenceScore: r.confidenceScore,
      matchType: r.matchType,
      riskLevel: r.riskLevel,
      bucket: bucketOf(r.eligible, r.matchScore, r.confidenceScore),
      blockerCodes: r.blockers.map((b) => b.code),
      scoreDelta: delta,
      scoreDirection: direction,
      autoCreated,
      scoredAt: new Date(startedAt),
    };
    if (previousScore !== undefined) set['previousScore'] = previousScore;
    if (matchSuggestionId) set['matchSuggestionId'] = matchSuggestionId;

    pairOps.push({
      updateOne: {
        filter: {
          internalCandidateId: new Types.ObjectId(ir.m._id),
          externalCandidateId: new Types.ObjectId(er.m._id),
        },
        update: { $set: set },
        upsert: true,
      },
    });

    if (pairsScored % PROGRESS_EVERY === 0) {
      await MatchScanState.updateOne(
        { singleton: 'match-scan' },
        { $set: { progressCurrent: pairsScored, draftsCreated, improved, declined } },
      ).exec();
    }
  }

  if (pairOps.length > 0) {
    await PairScore.bulkWrite(pairOps, { ordered: false });
  }

  // Persist new scoring hashes so the next incremental scan can skip
  // unchanged candidates. Skipped entirely in "missing" mode, where we
  // did NOT re-evaluate already-scored pairs — letting the delta scan
  // still pick up any changes later.
  if (mode !== 'missing') {
    await persistHashes(internalRows, externalRows, {
      truncated,
      touchedInternal,
      touchedExternal,
      startedAt,
    });
  }

  const summary: ScanSummary = {
    internalsConsidered: internalRows.length,
    externalsConsidered: externalRows.length,
    pairsScored,
    pairsSkipped,
    draftsCreated,
    improved,
    declined,
    durationMs: Date.now() - startedAt,
    truncated,
    lastScanAt: new Date(startedAt).toISOString(),
  };

  await MatchScanState.updateOne(
    { singleton: 'match-scan' },
    {
      $set: {
        status: 'done',
        progressCurrent: work.length,
        progressTotal: work.length,
        lastScanAt: new Date(startedAt),
        internalsConsidered: summary.internalsConsidered,
        externalsConsidered: summary.externalsConsidered,
        pairsScored: summary.pairsScored,
        pairsSkipped: summary.pairsSkipped,
        draftsCreated: summary.draftsCreated,
        improved: summary.improved,
        declined: summary.declined,
        durationMs: summary.durationMs,
      },
    },
  ).exec();

  return summary;
}

async function persistHashes(
  internalRows: Array<{ m: MatchableInternal; hash: string; dirty: boolean }>,
  externalRows: Array<{ m: MatchableExternal; hash: string; dirty: boolean }>,
  opts: { truncated: boolean; touchedInternal: Set<string>; touchedExternal: Set<string>; startedAt: number },
): Promise<void> {
  const hashedAt = new Date(opts.startedAt);
  const keepInternal = (id: string) => !opts.truncated || opts.touchedInternal.has(id);
  const keepExternal = (id: string) => !opts.truncated || opts.touchedExternal.has(id);

  const internalOps = internalRows
    .filter((r) => r.dirty && keepInternal(r.m._id))
    .map((r) => ({
      updateOne: {
        filter: { _id: new Types.ObjectId(r.m._id) },
        update: { $set: { scoringHash: r.hash, scoringHashAt: hashedAt } },
      },
    }));
  const externalOps = externalRows
    .filter((r) => r.dirty && keepExternal(r.m._id))
    .map((r) => ({
      updateOne: {
        filter: { _id: new Types.ObjectId(r.m._id) },
        update: { $set: { scoringHash: r.hash, scoringHashAt: hashedAt } },
      },
    }));

  await Promise.all([
    internalOps.length ? InternalCandidate.bulkWrite(internalOps, { ordered: false }) : Promise.resolve(),
    externalOps.length ? ExternalCandidate.bulkWrite(externalOps, { ordered: false }) : Promise.resolve(),
  ]);
}

// ── Scan results listing (PairScore + candidate names) ────

export interface ScanResultItem {
  internalCandidateId: string;
  externalCandidateId: string;
  internalName: string;
  externalName: string;
  matchScore: number;
  previousScore?: number;
  scoreDelta: number;
  scoreDirection: ScoreDirection;
  confidenceScore: number;
  matchType: string;
  eligible: boolean;
  bucket: PairScoreBucket;
  matchSuggestionId?: string;
  autoCreated: boolean;
  scoredAt: string;
  // The operator's reason recorded when this pair was held (review_later)
  // or dismissed (not_suitable). Empty for pending proposals.
  reviewReason?: string;
}

export interface ScanResultsQuery {
  direction?: ScoreDirection;
  eligibleOnly?: boolean;
  minScore?: number;
  autoCreated?: boolean;
  bucket?: PairScoreBucket;
  limit?: number;
  // Inbox tabs over the scored pairs:
  //   'inbox' (default): proposals awaiting a decision — excludes pairs that
  //      already became a suggestion (accepted), were marked not_suitable
  //      (dismissed), or were parked as review_later (on hold).
  //   'review_later': only pairs parked on hold (manualStatus review_later).
  //   'rejected': only pairs dismissed (manualStatus not_suitable).
  //   'all': every scored pair, undecorated.
  view?: 'inbox' | 'review_later' | 'rejected' | 'all';
}

export async function listScanResults(query: ScanResultsQuery): Promise<ScanResultItem[]> {
  const view = query.view ?? 'inbox';
  const filter: Record<string, unknown> = {};
  if (query.direction) filter['scoreDirection'] = query.direction;
  if (query.eligibleOnly) filter['eligible'] = true;
  if (query.bucket) filter['bucket'] = query.bucket;
  if (query.autoCreated !== undefined) filter['autoCreated'] = query.autoCreated;
  if (query.minScore !== undefined) filter['matchScore'] = { $gte: query.minScore };

  const want = Math.min(query.limit ?? 100, 500);
  // Over-fetch for any post-filtered view so the page still fills after culling.
  const fetchLimit = view === 'all' ? want : 500;
  const rows = await PairScore.find(filter)
    .sort({ matchScore: -1 })
    .limit(fetchLimit)
    .lean()
    .exec();

  // Decorate every non-'all' view with each pair's decision state, then keep
  // only the rows that belong in the requested tab.
  const keyOf = (x: { internalCandidateId: unknown; externalCandidateId: unknown }) =>
    `${String(x.internalCandidateId)}:${String(x.externalCandidateId)}`;
  let reviewReasons = new Map<string, string>();
  let visible = rows;
  if (view !== 'all') {
    const key = keyOf;
    const internalIds = [...new Set(rows.map((r) => String(r.internalCandidateId)))].map((id) => new Types.ObjectId(id));
    const [accepted, reviews] = await Promise.all([
      MatchSuggestion.find({ internalCandidateId: { $in: internalIds }, status: { $nin: ['closed', 'expired'] } })
        .select('internalCandidateId externalCandidateId').lean().exec(),
      PairReview.find({ internalCandidateId: { $in: internalIds }, manualStatus: { $in: ['not_suitable', 'review_later'] } })
        .select('internalCandidateId externalCandidateId manualStatus operatorReason').lean().exec(),
    ]);
    const acceptedSet = new Set(accepted.map((s) => key(s)));
    const reviewStatus = new Map(reviews.map((r) => [key(r), r.manualStatus]));
    reviewReasons = new Map(reviews.map((r) => [key(r), r.operatorReason ?? '']));

    if (view === 'inbox') {
      // Awaiting a decision: not accepted, not held, not dismissed.
      visible = rows.filter((r) => !acceptedSet.has(key(r)) && !reviewStatus.has(key(r)));
    } else if (view === 'review_later') {
      visible = rows.filter((r) => reviewStatus.get(key(r)) === 'review_later');
    } else {
      visible = rows.filter((r) => reviewStatus.get(key(r)) === 'not_suitable');
    }
  }
  visible = visible.slice(0, want);

  const internalIds = [...new Set(visible.map((r) => String(r.internalCandidateId)))];
  const externalIds = [...new Set(visible.map((r) => String(r.externalCandidateId)))];
  const [internals, externals] = await Promise.all([
    InternalCandidate.find({ _id: { $in: internalIds } }).select('firstName lastName').lean().exec(),
    ExternalCandidate.find({ _id: { $in: externalIds } }).select('firstName lastName').lean().exec(),
  ]);
  const nameOf = (c: { firstName?: string; lastName?: string }) =>
    `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'ללא שם';
  const internalNames = new Map(internals.map((c) => [String(c._id), nameOf(c)]));
  const externalNames = new Map(externals.map((c) => [String(c._id), nameOf(c)]));

  return visible.map((r) => ({
    internalCandidateId: String(r.internalCandidateId),
    externalCandidateId: String(r.externalCandidateId),
    internalName: internalNames.get(String(r.internalCandidateId)) ?? 'ללא שם',
    externalName: externalNames.get(String(r.externalCandidateId)) ?? 'ללא שם',
    matchScore: r.matchScore,
    ...(r.previousScore !== undefined ? { previousScore: r.previousScore } : {}),
    scoreDelta: r.scoreDelta,
    scoreDirection: r.scoreDirection,
    confidenceScore: r.confidenceScore,
    matchType: r.matchType,
    eligible: r.eligible,
    bucket: r.bucket,
    ...(r.matchSuggestionId ? { matchSuggestionId: String(r.matchSuggestionId) } : {}),
    autoCreated: r.autoCreated,
    scoredAt: r.scoredAt.toISOString(),
    ...(reviewReasons.get(keyOf(r)) ? { reviewReason: reviewReasons.get(keyOf(r)) } : {}),
  }));
}

export async function getScanState(): Promise<ScanStateView | null> {
  const state = await MatchScanState.findOne({ singleton: 'match-scan' }).lean().exec();
  if (!state) return null;
  return {
    status: state.status,
    mode: state.mode,
    running: state.status === 'running',
    progressCurrent: state.progressCurrent,
    progressTotal: state.progressTotal,
    internalsConsidered: state.internalsConsidered,
    externalsConsidered: state.externalsConsidered,
    pairsScored: state.pairsScored,
    pairsSkipped: state.pairsSkipped,
    draftsCreated: state.draftsCreated,
    improved: state.improved,
    declined: state.declined,
    durationMs: state.durationMs,
    ...(state.lastScanAt ? { lastScanAt: state.lastScanAt.toISOString() } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  };
}
