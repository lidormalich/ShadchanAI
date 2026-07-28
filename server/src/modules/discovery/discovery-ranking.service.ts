// ═══════════════════════════════════════════════════════════
// Discovery ranking — builds each swipe batch. The heart of
// "היכרות חכמה": exploration → exploitation.
//
// Per batch:
//   1. Engine pass (untouched deterministic engine) over the pool,
//      with the session's trait picks patched onto the internal's
//      matchable IN MEMORY (never persisted to the candidate doc).
//   2. Preference signals (all fail-soft, semantic-gated):
//        S — cosine vs the latest AI summary embedding
//        L — cosine vs the LIKED-cards centroid
//        R — cosine vs the REJECTED-cards centroid
//      P = clamp01(renorm(0.5·S + 0.5·L) − 0.3·R)
//      finalRank = 0.75·engineScore + 0.25·(100·P)   (engine keeps
//      75% authority — learned preferences reorder, never surface an
//      engine-poor pair to the top).
//   3. MMR-style diversity pick. Early rounds sample DELIBERATELY
//      across age/sector/status/region buckets so every rejection
//      carries signal; later rounds converge on what the candidate
//      actually responds to (λ decays).
//
// AI avoidFilters are applied as post-pool hard filters through a
// field allow-list — the AI can only NARROW the pool, never widen it
// or inject query shapes. LLM per-card re-rank is deliberately NOT
// implemented: S+L+R+avoidFilters give the refine effect with one
// bounded AI call per round; this function is the swap point if that
// ever changes.
// ═══════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { InternalCandidate, ExternalCandidate } from '../../models/index.js';
import { DiscoverySession, type IDiscoverySession, type IDiscoveryCard } from './discovery-session.model.js';
import { evaluatePair as engineEvaluatePair } from '../../services/matching/matching.engine.js';
import {
  toMatchableInternal,
  toMatchableExternal,
  buildEngineContext,
} from '../../services/matching/matchable.mapper.js';
import type { MatchableInternal } from '../../services/matching/matching.types.js';
import {
  buildSemanticSimilarityMap,
  loadExternalChunksMap,
  cosine,
} from '../../services/embedding/semantic-similarity.service.js';
import type { CandidateChunks, ChunkType } from '../../services/embedding/embedding.types.js';
import { isSemanticEnabled } from '../../services/embedding/embedding.gate.js';
import { getEmbeddingProvider } from '../../services/embedding/embedding.provider.js';
import { getSettingCached } from '../../modules/settings/settings.service.js';
import { buildDiscoveryCardDTO, type DiscoveryCardDTO } from './discovery-card.dto.js';
import { NotFoundError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('discovery.ranking');

const SCORING_POOL_CAP = 300;

// Preference-similarity chunk weights: what the candidate LIKES is
// mostly about expectations/personality fit; religious identity is
// already heavily engine-scored, so it gets less weight here.
const PREF_CHUNK_WEIGHTS: Record<ChunkType, number> = {
  expectations: 0.5,
  personality: 0.3,
  religious: 0.2,
  background: 0,
};

// Blend: engine keeps 75% authority over learned preferences.
const ENGINE_BLEND = 0.75;
// Rejected-centroid penalty inside P.
const REJECT_PENALTY = 0.3;
// Minimum verdicts before a centroid is trusted.
const MIN_LIKES_FOR_CENTROID = 2;
const MIN_REJECTS_FOR_CENTROID = 3;

// MMR diversity weight per round (1-based). Round 1 explores hard —
// 20 near-identical cards teach nothing; by round 3 we exploit.
function diversityLambda(batchIndex: number): number {
  if (batchIndex <= 1) return 0.45;
  if (batchIndex === 2) return 0.25;
  return 0.10;
}

// AI avoidFilter allow-list. Anything else is dropped and logged.
const AVOID_FILTER_FIELDS = new Set([
  'personalStatus', 'sectorGroup', 'region', 'maxAge', 'minAge', 'withChildren',
]);

type LeanExternal = Record<string, unknown> & {
  _id: Types.ObjectId;
  firstName?: string;
  lastName?: string;
  age?: number;
  region?: string;
  sectorGroup?: string;
  subSector?: string;
  personalStatus?: string;
  numberOfChildren?: number;
  currentOccupation?: string;
  educationLevel?: string;
  height?: number;
  about?: string;
  studyWorkDirection?: string;
  photoStorageKey?: string;
  shareCard?: { approvedForShare?: boolean; photoMode?: string };
  aiEnrichment?: { summary?: string };
};

// ── Trait-pick patching (in-memory only) ─────────────────

export function applyTraitPicks(
  matchable: MatchableInternal,
  picks: IDiscoverySession['traitPicks'],
): MatchableInternal {
  if (!picks) return matchable;
  const patched: MatchableInternal = { ...matchable };

  if (picks.ageMin !== undefined || picks.ageMax !== undefined) {
    patched.agePreferences = {
      ...(matchable.agePreferences ?? { flexibility: 'somewhat_flexible' }),
      ...(picks.ageMin !== undefined ? { min: picks.ageMin } : {}),
      ...(picks.ageMax !== undefined ? { max: picks.ageMax } : {}),
    };
  }

  if (picks.regions?.length) {
    patched.locationPreferences = {
      ...matchable.locationPreferences,
      regions: [...new Set([
        ...(matchable.locationPreferences?.regions ?? []),
        ...picks.regions,
      ])] as NonNullable<MatchableInternal['locationPreferences']>['regions'],
    };
  }

  if (picks.openness) {
    patched.openness = { ...matchable.openness, ...picks.openness };
  }

  if (picks.softPreferences?.length) {
    const overridden = new Set(picks.softPreferences.map((p) => p.field));
    patched.softPreferences = [
      ...(matchable.softPreferences ?? []).filter((p) => !overridden.has(p.field)),
      ...picks.softPreferences.map((p) => ({
        field: p.field,
        value: p.value,
        importance: p.importance as 'must_have' | 'important' | 'nice_to_have' | 'flexible',
      })),
    ];
  }

  return patched;
}

// ── AI avoid-filters (allow-listed narrowing only) ───────

export function applyAvoidFilters(
  pool: LeanExternal[],
  filters: Array<{ field: string; value: string }> | undefined,
): LeanExternal[] {
  if (!filters?.length) return pool;
  let out = pool;
  for (const f of filters) {
    if (!AVOID_FILTER_FIELDS.has(f.field)) {
      log.warn({ field: f.field }, 'avoid_filter_dropped_unknown_field');
      continue;
    }
    switch (f.field) {
      case 'personalStatus':
        out = out.filter((e) => e.personalStatus !== f.value);
        break;
      case 'sectorGroup':
        out = out.filter((e) => e.sectorGroup !== f.value);
        break;
      case 'region':
        out = out.filter((e) => e.region !== f.value);
        break;
      case 'maxAge': {
        const n = Number(f.value);
        if (Number.isFinite(n)) out = out.filter((e) => e.age === undefined || e.age <= n);
        break;
      }
      case 'minAge': {
        const n = Number(f.value);
        if (Number.isFinite(n)) out = out.filter((e) => e.age === undefined || e.age >= n);
        break;
      }
      case 'withChildren':
        out = out.filter((e) => (e.numberOfChildren ?? 0) === 0);
        break;
    }
  }
  return out;
}

// ── Preference signals (S / L / R) ───────────────────────

function centroidOfChunks(chunkSets: CandidateChunks[]): CandidateChunks | undefined {
  if (chunkSets.length === 0) return undefined;
  const out: CandidateChunks = {
    religious: undefined, expectations: undefined, personality: undefined, background: undefined,
  };
  for (const chunk of ['religious', 'expectations', 'personality', 'background'] as ChunkType[]) {
    const vectors = chunkSets.map((c) => c[chunk]).filter((v): v is number[] => Boolean(v));
    if (vectors.length === 0) continue;
    const dim = vectors[0]!.length;
    if (!vectors.every((v) => v.length === dim)) continue;
    const avg = new Array<number>(dim).fill(0);
    for (const v of vectors) for (let i = 0; i < dim; i++) avg[i]! += v[i]!;
    for (let i = 0; i < dim; i++) avg[i]! /= vectors.length;
    out[chunk] = avg;
  }
  return Object.values(out).some(Boolean) ? out : undefined;
}

/** Weighted cosine of external chunks vs a reference chunk set, using
 * the preference weights (renormalised over the shared subset). */
function prefSimilarity(ref: CandidateChunks, ext: CandidateChunks): number | undefined {
  let acc = 0;
  let weightSum = 0;
  for (const chunk of ['expectations', 'personality', 'religious'] as ChunkType[]) {
    const a = ref[chunk];
    const b = ext[chunk];
    if (!a || !b) continue;
    const sim = cosine(a, b);
    if (sim === undefined) continue;
    acc += Math.max(0, sim) * PREF_CHUNK_WEIGHTS[chunk];
    weightSum += PREF_CHUNK_WEIGHTS[chunk];
  }
  if (weightSum === 0) return undefined;
  return Math.min(1, Math.max(0, acc / weightSum));
}

/** Cosine of a single summary vector against external chunks (same
 * preference weights — the summary text talks about expectations). */
function summarySimilarity(summaryVec: number[], ext: CandidateChunks): number | undefined {
  let acc = 0;
  let weightSum = 0;
  for (const chunk of ['expectations', 'personality', 'religious'] as ChunkType[]) {
    const b = ext[chunk];
    if (!b) continue;
    const sim = cosine(summaryVec, b);
    if (sim === undefined) continue;
    acc += Math.max(0, sim) * PREF_CHUNK_WEIGHTS[chunk];
    weightSum += PREF_CHUNK_WEIGHTS[chunk];
  }
  if (weightSum === 0) return undefined;
  return Math.min(1, Math.max(0, acc / weightSum));
}

interface PrefSignals {
  summaryVec?: number[] | undefined;
  likedCentroid?: CandidateChunks | undefined;
  rejectedCentroid?: CandidateChunks | undefined;
}

/**
 * Builds the P-term signals from raw verdict ids + an optional AI
 * summary text. Fail-soft as a whole AND per component: any failure
 * just removes that signal.
 */
async function loadSignalsFromInputs(
  likedIds: string[],
  rejectedIds: string[],
  summaryText: string | undefined,
): Promise<PrefSignals> {
  const signals: PrefSignals = {};
  try {
    if (!(await isSemanticEnabled())) return signals;

    const verdictChunks = await loadExternalChunksMap([...new Set([...likedIds, ...rejectedIds])]);

    if (likedIds.length >= MIN_LIKES_FOR_CENTROID) {
      signals.likedCentroid = centroidOfChunks(
        likedIds.map((id) => verdictChunks.get(id)).filter((c): c is CandidateChunks => Boolean(c)),
      );
    }
    if (rejectedIds.length >= MIN_REJECTS_FOR_CENTROID) {
      signals.rejectedCentroid = centroidOfChunks(
        rejectedIds.map((id) => verdictChunks.get(id)).filter((c): c is CandidateChunks => Boolean(c)),
      );
    }

    if (summaryText) {
      try {
        const [vec] = await getEmbeddingProvider().embed([summaryText]);
        if (vec?.length) signals.summaryVec = vec;
      } catch (err) {
        log.warn({ error: String(err) }, 'summary_embed_failed');
      }
    }
  } catch (err) {
    log.warn({ error: String(err) }, 'pref_signals_failed');
  }
  return signals;
}

/** Session-scoped wrapper used by the public batch flow. */
async function loadPrefSignals(session: IDiscoverySession): Promise<PrefSignals> {
  return loadSignalsFromInputs(
    session.cards.filter((c) => c.verdict === 'like').map((c) => String(c.externalCandidateId)),
    session.cards.filter((c) => c.verdict === 'reject').map((c) => String(c.externalCandidateId)),
    session.aiSummaries.at(-1)?.summary,
  );
}

interface RankedCandidate {
  ext: LeanExternal;
  engineScore: number;
  strengths: string[];
  prefSim?: number | undefined;
  finalRank: number;
}

function computeP(
  signals: PrefSignals,
  extChunks: CandidateChunks | undefined,
): number | undefined {
  if (!extChunks) return undefined;

  const s = signals.summaryVec ? summarySimilarity(signals.summaryVec, extChunks) : undefined;
  const l = signals.likedCentroid ? prefSimilarity(signals.likedCentroid, extChunks) : undefined;
  const r = signals.rejectedCentroid ? prefSimilarity(signals.rejectedCentroid, extChunks) : undefined;

  if (s === undefined && l === undefined) return undefined;

  // Renormalise the positive term over whichever of S/L exist.
  let positive = 0;
  let weight = 0;
  if (s !== undefined) { positive += 0.5 * s; weight += 0.5; }
  if (l !== undefined) { positive += 0.5 * l; weight += 0.5; }
  positive /= weight;

  const p = positive - REJECT_PENALTY * (r ?? 0);
  return Math.min(1, Math.max(0, p));
}

// ── MMR diversity ────────────────────────────────────────

function diversityAxes(ext: LeanExternal): string[] {
  const axes: string[] = [];
  if (ext.age !== undefined) axes.push(`age:${Math.round(ext.age / 3)}`);
  if (ext.sectorGroup) axes.push(`sector:${ext.sectorGroup}`);
  if (ext.personalStatus) axes.push(`status:${ext.personalStatus}`);
  if (ext.region) axes.push(`region:${ext.region}`);
  if (ext.studyWorkDirection) axes.push(`work:${ext.studyWorkDirection}`);
  return axes;
}

/**
 * Greedy MMR selection: each pick maximises
 * (1−λ)·rankNorm + λ·noveltyGain, where noveltyGain is the fraction
 * of the card's diversity axes not yet covered by prior picks.
 */
export function selectDiverse(
  ranked: RankedCandidate[],
  count: number,
  lambda: number,
): RankedCandidate[] {
  if (ranked.length <= count) return [...ranked].sort((a, b) => b.finalRank - a.finalRank);

  const scores = ranked.map((r) => r.finalRank);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;

  const remaining = [...ranked];
  const selected: RankedCandidate[] = [];
  const covered = new Set<string>();

  while (selected.length < count && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!;
      const rankNorm = (cand.finalRank - min) / range;
      const axes = diversityAxes(cand.ext);
      const novelty = axes.length === 0
        ? 0.5 // no data → neutral, don't starve sparse profiles
        : axes.filter((a) => !covered.has(a)).length / axes.length;
      const score = (1 - lambda) * rankNorm + lambda * novelty;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    const picked = remaining.splice(bestIdx, 1)[0]!;
    selected.push(picked);
    for (const a of diversityAxes(picked.ext)) covered.add(a);
  }
  return selected;
}

// ── Batch builder ────────────────────────────────────────

export interface BuiltBatch {
  batchIndex: number;
  cards: DiscoveryCardDTO[];
  exhausted: boolean;
}

function cardHasPhoto(ext: LeanExternal): boolean {
  return Boolean(
    ext.photoStorageKey
    && ext.shareCard?.approvedForShare
    && (ext.shareCard.photoMode === 'blurred' || ext.shareCard.photoMode === 'full'),
  );
}

/**
 * Generates and persists the next batch for a session. Caller is
 * responsible for the atomic batch-index claim (see the public
 * router) — this function assumes it owns `batchIndex`.
 */
export async function buildDiscoveryBatch(
  session: IDiscoverySession,
  batchIndex: number,
): Promise<BuiltBatch> {
  const internal = await InternalCandidate.findById(session.internalCandidateId).lean().exec();
  if (!internal) throw new NotFoundError('InternalCandidate', String(session.internalCandidateId));

  const batchSize = Number(await getSettingCached('discovery.cards_per_batch'));
  const maxCards = Number(await getSettingCached('discovery.max_cards_per_session'));
  const remainingQuota = Math.max(0, maxCards - session.counters.served);
  const take = Math.min(batchSize, remainingQuota);
  if (take === 0) return { batchIndex, cards: [], exhausted: true };

  const servedIds = session.cards.map((c) => c.externalCandidateId);
  const oppositeGender = (internal as { gender?: string }).gender === 'male' ? 'female' : 'male';

  let pool = (await ExternalCandidate.find({
    gender: oppositeGender,
    status: 'active',
    availabilityStatus: { $in: ['available', 'unknown'] },
    _id: { $nin: servedIds },
  })
    .sort({ createdAt: -1 })
    .limit(SCORING_POOL_CAP)
    .lean()
    .exec()) as unknown as LeanExternal[];

  pool = applyAvoidFilters(pool, session.aiSummaries.at(-1)?.avoidFilters);
  if (pool.length === 0) return { batchIndex, cards: [], exhausted: true };

  // Engine pass — trait picks patched in memory, engine untouched.
  // Discovery mode: this surface exists to explore, not to gate.
  const ctx = await buildEngineContext(String(session.internalCandidateId), 'discovery');
  const semantic = await buildSemanticSimilarityMap(
    String(session.internalCandidateId),
    pool.map((e) => String(e._id)),
  );
  if (semantic) ctx.semanticSimilarities = semantic;

  const matchable = applyTraitPicks(toMatchableInternal(internal), session.traitPicks);

  const eligible: RankedCandidate[] = [];
  for (const ext of pool) {
    const r = engineEvaluatePair(matchable, toMatchableExternal(ext), ctx);
    if (!r.eligible) continue;
    eligible.push({ ext, engineScore: r.matchScore, strengths: r.strengths, finalRank: r.matchScore });
  }
  if (eligible.length === 0) return { batchIndex, cards: [], exhausted: true };

  // Preference blend (round 2+ has verdicts/summaries; round 1 is pure engine).
  const signals = await loadPrefSignals(session);
  if (signals.summaryVec || signals.likedCentroid || signals.rejectedCentroid) {
    const extChunks = await loadExternalChunksMap(eligible.map((c) => String(c.ext._id)));
    for (const cand of eligible) {
      const p = computeP(signals, extChunks.get(String(cand.ext._id)));
      if (p !== undefined) {
        cand.prefSim = p;
        cand.finalRank = ENGINE_BLEND * cand.engineScore + (1 - ENGINE_BLEND) * (100 * p);
      }
    }
  }

  eligible.sort((a, b) => b.finalRank - a.finalRank);
  const picked = selectDiverse(eligible, take, diversityLambda(batchIndex));

  const now = new Date();
  const cards: IDiscoveryCard[] = picked.map((c) => ({
    cardId: crypto.randomBytes(8).toString('base64url'),
    externalCandidateId: c.ext._id,
    batchIndex,
    servedAt: now,
    engineScore: c.engineScore,
    prefSim: c.prefSim,
    finalRank: c.finalRank,
    hasPhoto: cardHasPhoto(c.ext),
  }));

  await DiscoverySession.updateOne(
    { _id: session._id },
    {
      $push: { cards: { $each: cards } },
      $inc: { 'counters.served': cards.length },
    },
  ).exec();

  const dtoByCardId = new Map(picked.map((c, i) => [cards[i]!.cardId, c]));
  const dtos = cards.map((card) => {
    const c = dtoByCardId.get(card.cardId)!;
    return buildDiscoveryCardDTO(card.cardId, c.ext, c.strengths, card.hasPhoto);
  });

  // Exhausted when the pool can't fill another batch or quota is done.
  const exhausted = session.counters.served + cards.length >= maxCards
    || eligible.length <= cards.length;

  log.info({
    sessionId: String(session._id),
    batchIndex,
    poolSize: pool.length,
    eligibleCount: eligible.length,
    served: cards.length,
    withPrefSignal: picked.filter((p) => p.prefSim !== undefined).length,
    exhausted,
  }, 'discovery_batch_built');

  return { batchIndex, cards: dtos, exhausted };
}

// ── Operator-facing: rank the pool by revealed preferences ──
//
// The auth-gated counterpart of the public batch: ranks the SAME pool
// with the SAME blend, but aggregates signals across ALL of the
// candidate's discovery sessions, returns real identities, and never
// hides already-swiped candidates — it decorates them with the
// verdict instead. Powers the "לפי ההיכרות" tab.

export interface RevealedPreferenceRow {
  externalCandidateId: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  age?: number | undefined;
  city?: string | undefined;
  sectorGroup?: string | undefined;
  personalStatus?: string | undefined;
  engineScore: number;
  /** Blended preference similarity 0..1, when semantic signals exist. */
  prefSim?: number | undefined;
  finalRank: number;
  strengths: string[];
  candidateVerdict?: { verdict: 'like' | 'reject' | 'skip'; reasons: string[]; at?: string | undefined } | undefined;
}

export interface RevealedPreferenceRanking {
  available: boolean;
  /** Why the ranking is empty — for a friendly operator empty-state. */
  reason?: 'no_sessions' | 'no_verdicts' | undefined;
  semanticActive: boolean;
  signals: { likes: number; rejects: number; hasAiSummary: boolean };
  learnedSummary?: string | undefined;
  /** Signal chips from the latest AI summary: what draws / repels. */
  positiveSignals: string[];
  negativeSignals: string[];
  rows: RevealedPreferenceRow[];
}

export async function rankByRevealedPreferences(
  internalId: string,
  limit = 50,
): Promise<RevealedPreferenceRanking> {
  const sessions = await DiscoverySession.find({
    internalCandidateId: new Types.ObjectId(internalId),
    $or: [{ 'cards.verdict': { $exists: true } }, { 'aiSummaries.0': { $exists: true } }],
  })
    .sort({ createdAt: 1 })
    .select('cards aiSummaries')
    .lean()
    .exec();

  const empty = (reason: 'no_sessions' | 'no_verdicts'): RevealedPreferenceRanking => ({
    available: false,
    reason,
    semanticActive: false,
    signals: { likes: 0, rejects: 0, hasAiSummary: false },
    positiveSignals: [],
    negativeSignals: [],
    rows: [],
  });
  if (sessions.length === 0) return empty('no_sessions');

  // Aggregate across sessions — newest verdict per external wins.
  const verdictByExternal = new Map<string, { verdict: 'like' | 'reject' | 'skip'; reasons: string[]; at?: string | undefined }>();
  for (const s of sessions) {
    for (const c of s.cards ?? []) {
      if (!c.verdict) continue;
      verdictByExternal.set(String(c.externalCandidateId), {
        verdict: c.verdict,
        reasons: [...(c.reasonChips ?? []), ...(c.reasonText ? [c.reasonText] : [])],
        at: c.verdictAt ? new Date(c.verdictAt).toISOString() : undefined,
      });
    }
  }
  const likedIds = [...verdictByExternal].filter(([, v]) => v.verdict === 'like').map(([id]) => id);
  const rejectedIds = [...verdictByExternal].filter(([, v]) => v.verdict === 'reject').map(([id]) => id);
  const latestSummaryEntry = [...sessions].reverse()
    .flatMap((s) => s.aiSummaries ?? [])
    .at(0);
  const latestSummary = latestSummaryEntry?.summary;

  if (verdictByExternal.size === 0 && !latestSummary) return empty('no_verdicts');

  const internal = await InternalCandidate.findById(internalId).lean().exec();
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);
  const oppositeGender = (internal as { gender?: string }).gender === 'male' ? 'female' : 'male';

  const pool = (await ExternalCandidate.find({
    gender: oppositeGender,
    status: 'active',
    availabilityStatus: { $in: ['available', 'unknown'] },
  })
    .sort({ createdAt: -1 })
    .limit(SCORING_POOL_CAP)
    .lean()
    .exec()) as unknown as LeanExternal[];

  const ctx = await buildEngineContext(internalId, 'discovery');
  const semantic = await buildSemanticSimilarityMap(internalId, pool.map((e) => String(e._id)));
  if (semantic) ctx.semanticSimilarities = semantic;
  const matchable = toMatchableInternal(internal);

  const eligible: RankedCandidate[] = [];
  for (const ext of pool) {
    const r = engineEvaluatePair(matchable, toMatchableExternal(ext), ctx);
    if (!r.eligible) continue;
    eligible.push({ ext, engineScore: r.matchScore, strengths: r.strengths, finalRank: r.matchScore });
  }

  const signals = await loadSignalsFromInputs(likedIds, rejectedIds, latestSummary);
  const semanticActive = Boolean(signals.summaryVec || signals.likedCentroid || signals.rejectedCentroid);
  if (semanticActive) {
    const extChunks = await loadExternalChunksMap(eligible.map((c) => String(c.ext._id)));
    for (const cand of eligible) {
      const p = computeP(signals, extChunks.get(String(cand.ext._id)));
      if (p !== undefined) {
        cand.prefSim = p;
        cand.finalRank = ENGINE_BLEND * cand.engineScore + (1 - ENGINE_BLEND) * (100 * p);
      }
    }
  }

  eligible.sort((a, b) => b.finalRank - a.finalRank);

  return {
    available: true,
    semanticActive,
    signals: {
      likes: likedIds.length,
      rejects: rejectedIds.length,
      hasAiSummary: Boolean(latestSummary),
    },
    learnedSummary: latestSummary,
    positiveSignals: latestSummaryEntry?.positiveSignals ?? [],
    negativeSignals: latestSummaryEntry?.negativeSignals ?? [],
    rows: eligible.slice(0, limit).map((c) => ({
      externalCandidateId: String(c.ext._id),
      firstName: c.ext.firstName,
      lastName: c.ext.lastName,
      age: c.ext.age,
      city: (c.ext as { city?: string }).city,
      sectorGroup: c.ext.sectorGroup,
      personalStatus: c.ext.personalStatus,
      engineScore: c.engineScore,
      prefSim: c.prefSim,
      finalRank: Math.round(c.finalRank * 10) / 10,
      strengths: c.strengths.slice(0, 3),
      candidateVerdict: verdictByExternal.get(String(c.ext._id)),
    })),
  };
}

/** Rebuilds DTOs for already-persisted unanswered cards (refresh / race-loser path). */
export async function dtosForExistingCards(
  session: IDiscoverySession,
  cards: IDiscoveryCard[],
): Promise<DiscoveryCardDTO[]> {
  const externals = (await ExternalCandidate.find({
    _id: { $in: cards.map((c) => c.externalCandidateId) },
  }).lean().exec()) as unknown as LeanExternal[];
  const byId = new Map(externals.map((e) => [String(e._id), e]));

  const out: DiscoveryCardDTO[] = [];
  for (const card of cards) {
    const ext = byId.get(String(card.externalCandidateId));
    if (!ext) continue;
    // Strengths aren't persisted per card; on the resume path the chips
    // are omitted rather than re-running the engine for a page refresh.
    out.push(buildDiscoveryCardDTO(card.cardId, ext, [], card.hasPhoto));
  }
  return out;
}
