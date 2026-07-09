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
import { createLogger } from '../../utils/logger.js';
import { isSemanticEnabled } from '../embedding/embedding.gate.js';
import {
  ensureEmbeddingsForScan,
  loadExternalChunksMap,
  similarityMapFromChunks,
} from '../embedding/semantic-similarity.service.js';
import { loadChunksForQuery } from '../embedding/embedding.service.js';
import type { CandidateChunks } from '../embedding/embedding.types.js';
import type { MatchableInternal, MatchableExternal, MatchingContext } from './matching.types.js';
import type { PairScoreBucket, ScoreDirection, ScanMode, ScanStatus } from '../../modules/matches/pair-score.model.js';

const log = createLogger('match-scan');

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

// Semantic add-on: external vectors are prefetched once per scan and
// reused across every internal (pure-CPU cosine per pair afterwards).
// Above this pool size the prefetch would hold too much vector data in
// memory (~50KB/candidate), so we skip semantic for that scan and log.
const SEMANTIC_SCAN_MAX_EXTERNALS = 2_000;

// Only one scan may run at a time (single-instance server).
let scanInFlight = false;

// Field projections for loading candidates into the matching engine.
// Shared by the scan and by the lazy reasons-backfill so both feed the
// engine the exact same inputs.
const INTERNAL_SCAN_SELECT =
  'firstName lastName gender dateOfBirth city region ethnicity lifeGoals height sectorGroup subSector ' +
  'lifestyleTone religiousStyle personalStatus numberOfChildren lifeStage ' +
  'readinessForMarriage studyWorkDirection hardConstraints softPreferences ' +
  'agePreferences locationPreferences openness profileCompletion ' +
  'missingCriticalFields sendReadinessBlockers profileQualityScore ' +
  'dataReliabilityScore readinessScore status lastVerifiedAt lastActionAt ' +
  'datingPartnerCandidateId deferredSuggestionsCount scoringHash ownerUserId';
const EXTERNAL_SCAN_SELECT =
  'firstName lastName gender age city region ethnicity lifeGoals height sectorGroup subSector ' +
  'lifestyleTone personalStatus lifeStage studyWorkDirection ' +
  'availabilityStatus status shareCard ageReliability hardConstraints ' +
  'softPreferences agePreferences locationPreferences openness staleAt ' +
  'lastConfirmedAvailableAt lastSourceUpdateAt sourceImportedAt scoringHash';

// How many strengths / attention points to keep per pair in the cache.
const REASONS_KEPT = 3;

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

/**
 * Bump whenever engine logic / weights / dimensions change. Salting the
 * hash forces one full re-score after such a deploy — otherwise cached
 * PairScore rows keep scores computed by the OLD engine indefinitely
 * (the candidate-field hash alone can't see code changes).
 */
const ENGINE_VERSION = 'v2';

/**
 * Time-based penalties (stale externals, internal timing) and context
 * inputs (active-suggestion load, recent declines) are functions of NOW
 * and of suggestion churn — invisible to the candidate-field hashes. A
 * forced periodic re-score bounds that drift: any pair whose row is older
 * than this TTL is treated as dirty on the incremental scan. Fallback
 * only — the operator tunes it via 'matching.rescore_ttl_days'.
 */
const RESCORE_TTL_DAYS_DEFAULT = 7;

function hashOf(parts: unknown[]): string {
  return createHash('sha1').update(JSON.stringify([ENGINE_VERSION, ...parts])).digest('hex');
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
    // Penalty inputs — computeTimingPenalty reads lastActionAt; without it
    // an operator action never dirtied the pair and the stale score stuck.
    m.lastActionAt,
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
    // Penalty inputs — computeStalePenalty's reference date chain. E.g.
    // confirming availability should LIFT the stale penalty immediately.
    m.lastConfirmedAvailableAt, m.lastSourceUpdateAt, m.sourceImportedAt,
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

  const [scanMinScore, autoEnabled, autoMinScore, rescoreTtlDays, fallbackOwner] = await Promise.all([
    getSettingNumber('matching.scan_min_score'),
    getSettingBoolean('matching.scan_autocreate_enabled'),
    getSettingNumber('matching.scan_autocreate_min_score'),
    getSettingNumber('matching.rescore_ttl_days').catch(() => RESCORE_TTL_DAYS_DEFAULT),
    resolveFallbackOwner(opts.performedBy),
  ]);
  const rescoreTtlMs = rescoreTtlDays * 24 * 60 * 60 * 1000;

  const [internals, externals] = await Promise.all([
    InternalCandidate.find({ status: 'active', archivedAt: { $exists: false } })
      .select(INTERNAL_SCAN_SELECT)
      .lean()
      .exec(),
    ExternalCandidate.find({
      status: 'active',
      archivedAt: { $exists: false },
      availabilityStatus: { $in: ['available', 'unknown'] },
    })
      .select(EXTERNAL_SCAN_SELECT)
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
    .select('internalCandidateId externalCandidateId matchScore scoredAt')
    .lean()
    .exec();
  const prevByPair = new Map<string, { score: number; scoredAt?: Date }>();
  for (const row of existing) {
    const key = `${String(row.internalCandidateId)}:${String(row.externalCandidateId)}`;
    prevByPair.set(key, { score: row.matchScore, scoredAt: row.scoredAt });
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

  // Pairs the operator already ENDED (closed/expired). Never auto-create a new
  // draft for these — otherwise a scan resurfaces a suggestion the operator
  // dismissed (the partial unique index doesn't cover closed rows, so a fresh
  // draft would insert fine). Consistent with findMatchingInternals hiding them.
  const terminatedKeys = new Set<string>();
  {
    const ended = await MatchSuggestion.find({
      internalCandidateId: { $in: internalIds },
      status: { $in: ['closed', 'expired'] },
    }).select('internalCandidateId externalCandidateId').lean().exec();
    for (const s of ended) {
      terminatedKeys.add(`${String(s.internalCandidateId)}:${String(s.externalCandidateId)}`);
    }
  }

  // ── Build the work-list (so progressTotal is exact) ──────
  type IR = (typeof internalRows)[number];
  type ER = (typeof externalRows)[number];
  const work: Array<{ ir: IR; er: ER; pairKey: string }> = [];
  let pairsSkipped = 0;
  let truncated = false;

  const scanNow = Date.now();
  outer: for (const ir of internalRows) {
    const internalGender = ir.m.gender;
    if (!internalGender) continue;
    const oppositeGender = internalGender === 'male' ? 'female' : 'male';
    for (const er of externalRows) {
      if (er.m.gender !== oppositeGender) continue;
      const pairKey = `${ir.m._id}:${er.m._id}`;
      // TTL re-score: rows older than RESCORE_TTL_MS (or missing entirely,
      // e.g. dropped by a past truncation) count as dirty so time-based
      // penalties and context drift self-correct without a manual full scan.
      const prev = prevByPair.get(pairKey);
      const pairStale =
        mode === 'incremental' &&
        (!prev || !prev.scoredAt || scanNow - prev.scoredAt.getTime() > rescoreTtlMs);
      const include = mode === 'missing'
        ? !suggestedKeys.has(pairKey)
        : (mode === 'full' || ir.dirty || er.dirty || pairStale);
      if (!include) { pairsSkipped++; continue; }
      // Cap reached → stop building the work-list entirely instead of
      // spinning through the rest of the cross-product doing nothing.
      if (work.length >= MAX_PAIRS_PER_SCAN) { truncated = true; break outer; }
      work.push({ ir, er, pairKey });
    }
  }

  await MatchScanState.updateOne(
    { singleton: 'match-scan' },
    { $set: { progressTotal: work.length, progressCurrent: 0 } },
  ).exec();

  // ── Semantic add-on prep (admin-gated, fail-soft) ────────
  // Lazily embed candidates that have no vectors yet (capped per run,
  // converges over a few scans), then prefetch all external vectors
  // once so the per-pair cosine below is pure CPU.
  let externalChunksCache: Map<string, CandidateChunks> | null = null;
  try {
    if (work.length > 0 && await isSemanticEnabled()) {
      const workInternalIds = [...new Set(work.map((w) => w.ir.m._id))];
      const workExternalIds = [...new Set(work.map((w) => w.er.m._id))];
      await ensureEmbeddingsForScan(workInternalIds, workExternalIds);
      if (workExternalIds.length <= SEMANTIC_SCAN_MAX_EXTERNALS) {
        externalChunksCache = await loadExternalChunksMap(workExternalIds);
      } else {
        log.warn(
          { externals: workExternalIds.length, cap: SEMANTIC_SCAN_MAX_EXTERNALS },
          'semantic_skipped_pool_too_large',
        );
      }
    }
  } catch (err) {
    log.warn({ error: String(err) }, 'semantic_prep_failed');
    externalChunksCache = null;
  }

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
      if (externalChunksCache && externalChunksCache.size > 0) {
        try {
          const internalChunks = await loadChunksForQuery(ir.m._id, 'internal');
          const semantic = similarityMapFromChunks(internalChunks, externalChunksCache);
          if (semantic) ctx.semanticSimilarities = semantic;
        } catch (err) {
          log.warn({ internalId: ir.m._id, error: String(err) }, 'semantic_map_failed');
        }
      }
      ctxCache.set(ir.m._id, ctx);
    }

    const r = engineEvaluatePair(ir.m, er.m, ctx);
    pairsScored++;
    touchedInternal.add(ir.m._id);
    touchedExternal.add(er.m._id);

    const previousScore = prevByPair.get(pairKey)?.score;
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
      !terminatedKeys.has(pairKey) &&
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
      strengths: r.strengths.slice(0, REASONS_KEPT),
      attentionPoints: r.attentionPoints.slice(0, REASONS_KEPT),
      ageOutOfRange: r.ageOutOfRange,
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

  // Sweep orphaned rows: pairs referencing candidates that are no longer
  // in the active scan sets (archived / deleted / unavailable externals).
  // Without this they surface forever in the inbox as nameless entries.
  if (mode !== 'missing') {
    const externalIdSet = externalRows.map((r) => new Types.ObjectId(r.m._id));
    const removed = await PairScore.deleteMany({
      $or: [
        { internalCandidateId: { $nin: internalIds } },
        { externalCandidateId: { $nin: externalIdSet } },
      ],
    }).exec();
    if (removed.deletedCount > 0) {
      log.info({ removed: removed.deletedCount }, 'pair_score_orphans_removed');
    }
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
  // Short engine rationale: why the pair fits, and where the gaps are.
  strengths: string[];
  attentionPoints: string[];
  // Soft age-range exception: a stated age preference is violated beyond
  // ±tolerance. The pair is still shown; the UI marks it as an exception.
  ageOutOfRange: boolean;
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
  // Score floor: an explicit filter wins; otherwise the pending inbox applies
  // the configurable matching.scan_min_score so weak pairs don't flood the
  // proposals. Decision tabs (held/rejected) are never floored — the operator
  // already acted on those, so they must stay visible regardless of score.
  if (query.minScore !== undefined) {
    filter['matchScore'] = { $gte: query.minScore };
  } else if (view === 'inbox') {
    const floor = await getSettingNumber('matching.scan_min_score');
    filter['matchScore'] = { $gte: floor };
  }

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

  // Backfill rationale for rows scored before strengths/attentionPoints or the
  // ageOutOfRange flag were cached, so the inbox is never stale for legacy
  // pairs. Also re-backfill rows whose cached reasons still hold the old
  // English engine text (migrate to the current Hebrew details).
  const holdsEnglish = (r: PairScoreRow) =>
    [...(r.strengths ?? []), ...(r.attentionPoints ?? [])].some((s) => /[A-Za-z]/.test(s));
  await backfillReasons(visible.filter(
    (r) => (!r.strengths?.length && !r.attentionPoints?.length)
      || (r as { ageOutOfRange?: boolean }).ageOutOfRange === undefined
      || holdsEnglish(r as PairScoreRow),
  ));

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
    strengths: r.strengths ?? [],
    attentionPoints: r.attentionPoints ?? [],
    ageOutOfRange: r.ageOutOfRange ?? false,
    ...(reviewReasons.get(keyOf(r)) ? { reviewReason: reviewReasons.get(keyOf(r)) } : {}),
  }));
}

/**
 * Lazily compute + persist strengths/attentionPoints for pairs whose cache
 * row predates those fields. Mutates the passed rows in place so the current
 * response is complete, and writes the values back so the next listing is a
 * cache hit. A best-effort backfill — failures never break the listing.
 */
type PairScoreRow = {
  _id: unknown;
  internalCandidateId: unknown;
  externalCandidateId: unknown;
  strengths?: string[];
  attentionPoints?: string[];
  ageOutOfRange?: boolean;
};

async function backfillReasons(rows: PairScoreRow[]): Promise<void> {
  if (!rows.length) return;
  try {
    const internalIds = [...new Set(rows.map((r) => String(r.internalCandidateId)))];
    const externalIds = [...new Set(rows.map((r) => String(r.externalCandidateId)))];
    const [internals, externals] = await Promise.all([
      InternalCandidate.find({ _id: { $in: internalIds } }).select(INTERNAL_SCAN_SELECT).lean().exec(),
      ExternalCandidate.find({ _id: { $in: externalIds } }).select(EXTERNAL_SCAN_SELECT).lean().exec(),
    ]);
    const intMap = new Map(internals.map((d) => [String(d._id), toMatchableInternal(d as Record<string, unknown>)]));
    const extMap = new Map(externals.map((d) => [String(d._id), toMatchableExternal(d as Record<string, unknown>)]));

    const ctxCache = new Map<string, MatchingContext>();
    const ops: Parameters<typeof PairScore.bulkWrite>[0] = [];
    for (const row of rows) {
      const im = intMap.get(String(row.internalCandidateId));
      const em = extMap.get(String(row.externalCandidateId));
      if (!im || !em) continue;
      let ctx = ctxCache.get(im._id);
      if (!ctx) {
        ctx = await buildEngineContext(im._id, SourceMode.DISCOVERY);
        ctxCache.set(im._id, ctx);
      }
      const r = engineEvaluatePair(im, em, ctx);
      const strengths = r.strengths.slice(0, REASONS_KEPT);
      const attentionPoints = r.attentionPoints.slice(0, REASONS_KEPT);
      const ageOutOfRange = r.ageOutOfRange;
      row.strengths = strengths;
      row.attentionPoints = attentionPoints;
      row.ageOutOfRange = ageOutOfRange;
      ops.push({ updateOne: { filter: { _id: row._id }, update: { $set: { strengths, attentionPoints, ageOutOfRange } } } });
    }
    if (ops.length) await PairScore.bulkWrite(ops, { ordered: false });
  } catch {
    // Backfill is best-effort; leave the affected rows with empty reasons.
  }
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
