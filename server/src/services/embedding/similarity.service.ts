// ═══════════════════════════════════════════════════════════
// ShadchanAI — Hybrid Search / Similarity Service
//
// Implements MongoDB Atlas Hybrid Search using $rankFusion over 4
// independent semantic chunk vectors.  All vector scoring and rank
// fusion happen ENTIRELY inside Atlas — Node.js only sends the query
// vectors and receives ranked document IDs + scores back.
//
// ── Pipeline overview ────────────────────────────────────────
//
//   ┌─ religious    ($vectorSearch + pre-filter) ──weight 0.40 ─┐
//   ├─ expectations ($vectorSearch + pre-filter) ──weight 0.30 ─┤
//   ├─ personality  ($vectorSearch + pre-filter) ──weight 0.20 ─┤ → $rankFusion → $sort → $limit
//   └─ background   ($vectorSearch + pre-filter) ──weight 0.10 ─┘
//
// ── RRF score formula (computed by Atlas) ────────────────────
//
//   fusedScore(doc) = Σᵢ  weightᵢ × ( 1 / (RRF_K + rankᵢ) )
//
//   Where:
//     weightᵢ  = per-chunk importance weight (must sum to 1.0)
//     rankᵢ    = 1-based position of doc in chunk i's sorted results
//     RRF_K    = stabilising constant, default 60 (Cormack et al., 2009)
//
//   Documents absent from a chunk's results contribute 0 for that
//   term — they are not penalised for missing chunks, they simply
//   receive less signal from that semantic domain.
//
// ── Weight rationale ─────────────────────────────────────────
//
//   religious    = 0.40 — Primary filter in Israel's religious dating
//                          market.  Sector / lifestyle mismatch is the
//                          single most common reason matches are rejected
//                          outright before the first meeting.
//
//   expectations = 0.30 — What the candidate explicitly states they are
//                          seeking (whatSeeking, constraints, openness).
//                          The strongest signal after religious identity.
//
//   personality  = 0.20 — Character, self-description, values.  Important
//                          but shadchanim often override a personality
//                          delta through personal judgement, so weighted
//                          lower than the explicit-preference signal.
//
//   background   = 0.10 — Demographics: city, education, life-stage,
//                          army service.  These are ALSO enforced by the
//                          Atlas pre-filter (age ± dateOfBirth bounds), so
//                          we keep this weight minimal to avoid
//                          double-counting hard constraints as soft signal.
//
// ── Pre-filter strategy (zero false positives) ───────────────
//
//   Hard constraints are encoded INSIDE each $vectorSearch's `filter`
//   parameter — not as a post-fusion $match.  Because Atlas evaluates
//   the filter at the vector-index level, before ANN scoring begins,
//   wrong-gender / out-of-range-age candidates never enter the ANN
//   candidate pool and cannot surface in the results regardless of
//   vector similarity.
//
//   A safety-net $match stage after $rankFusion catches any document
//   whose status changed between indexing and query time.
//
// ── Required Atlas indexes (must be created before use) ──────
//
//   Collection: internalCandidates
//   ┌──────────────────────────────────┬──────────────────────────────────┬────────────────┐
//   │ Index name                       │ vectorPath                       │ numDimensions  │
//   ├──────────────────────────────────┼──────────────────────────────────┼────────────────┤
//   │ embedding_religious              │ embedding.religious.vector       │ 1024 (bge-m3)  │
//   │ embedding_expectations           │ embedding.expectations.vector    │ 1024           │
//   │ embedding_personality            │ embedding.personality.vector     │ 1024           │
//   │ embedding_background             │ embedding.background.vector      │ 1024           │
//   └──────────────────────────────────┴──────────────────────────────────┴────────────────┘
//
//   Every index must also declare these filter fields so Atlas can apply
//   the pre-filter at the index level:
//     { "type": "filter", "path": "gender" }
//     { "type": "filter", "path": "status" }
//     { "type": "filter", "path": "readinessForMarriage" }
//     { "type": "filter", "path": "dateOfBirth" }
//
//   Similarity function: cosine  (bge-m3 is trained for cosine similarity)
//
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { InternalCandidate } from '../../models/index.js';
import { CandidateStatus, Gender, ReadinessForMarriage } from '@shadchanai/shared';
import type { IInternalCandidate } from '../../modules/candidates/internal-candidate.model.js';
import { loadChunksForQuery } from './embedding.service.js';
import type { ChunkType, CandidateChunks } from './embedding.types.js';
import { ALL_CHUNK_TYPES, CHUNK_WEIGHTS } from './embedding.types.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('similarity.service');

// ── Atlas index configuration ─────────────────────────────

// Index names must exactly match the names created in the Atlas UI / Terraform.
// A mismatch causes a runtime error from Atlas (index not found), not a compile-
// time error — integration-test with a real cluster before deploying.
const VECTOR_INDEX: Readonly<Record<ChunkType, string>> = {
  religious:    'embedding_religious',
  expectations: 'embedding_expectations',
  personality:  'embedding_personality',
  background:   'embedding_background',
} as const;

// ── ANN tuning ────────────────────────────────────────────

// numCandidates = number of approximate-nearest-neighbour candidates each
// $vectorSearch considers internally BEFORE applying the pre-filter and
// returning `limit` results.
//
// A larger value gives better recall at the cost of Atlas CPU and latency.
// Atlas recommends numCandidates ≥ 10 × (sub-pipeline limit).
// Rule of thumb: if the pre-filter is very selective (e.g., only 200 active
// females in the index), raise this to avoid the ANN exhausting its budget
// on filtered-out documents before it reaches the target number of results.
const ANN_CANDIDATES_MULTIPLIER = 10;

// Hard cap per sub-pipeline to prevent runaway cost on M10 / M20 clusters.
// M10: ~1 000 is safe.  M20+: can raise to 2 000.
const MAX_ANN_CANDIDATES = 1_000;

// Statuses that make a candidate eligible for new suggestions.
// PAUSED and other statuses are intentionally excluded so we don't surface
// candidates who are temporarily unavailable.
const ELIGIBLE_READINESS: readonly ReadinessForMarriage[] = [
  ReadinessForMarriage.ACTIVELY_LOOKING,
  ReadinessForMarriage.OPEN,
] as const;

// Aggregation timeout covers the full Atlas roundtrip including ANN search.
const PIPELINE_TIMEOUT_MS = 10_000;

// ── Public types ──────────────────────────────────────────

export interface RankedCandidate {
  /** Fully hydrated candidate document (plain object — no Mongoose methods). */
  candidate: IInternalCandidate;

  /**
   * Atlas $rankFusion weighted-RRF score.  Higher = better semantic match.
   *
   * The score is an opaque ordinal: treat it as a relative ranking signal
   * within a single query, not an absolute probability or percentage.
   *
   * Approximate range: (0, Σ weightᵢ / RRF_K].
   *   All-4-chunks + rank-1 in every sub-pipeline ≈ (0.40+0.30+0.20+0.10)/60 ≈ 0.0167
   */
  score: number;
}

export interface SimilaritySearchOptions {
  /**
   * Maximum number of candidates to return.
   * Defaults to 5 — typical usage is a short shortlist fed to the engine.
   */
  limit?: number;

  /**
   * Override numCandidates per $vectorSearch sub-pipeline.
   * Defaults to min(SEMANTIC_TOP_K × 10, 1000).
   * Raise if you observe truncated results on a highly selective filter.
   */
  numCandidates?: number;
}

// ── Atlas stage types ─────────────────────────────────────
//
// Mongoose's PipelineStage union does not include $rankFusion or the
// 'rankFusionScore' $meta variant (Atlas-only, not in vanilla MongoDB).
// We define narrow internal types and cast to `unknown` when feeding the
// pipeline array to Mongoose's aggregate(), which accepts any stage shape.

interface VectorSearchStage {
  $vectorSearch: {
    index:         string;
    path:          string;
    queryVector:   number[];
    numCandidates: number;
    limit:         number;
    filter?:       Record<string, unknown>;
  };
}

interface RankFusionStage {
  $rankFusion: {
    input: {
      pipelines: Partial<Record<ChunkType, VectorSearchStage[]>>;
    };
    combination: {
      // Scalar multipliers for each pipeline's RRF contribution.
      // $rankFusion does not require them to sum to 1, but we normalise
      // them anyway so scores stay comparable when only a subset of chunks
      // is available (e.g., a newly created profile missing the background chunk).
      weights: Partial<Record<ChunkType, number>>;
    };
  };
}

// ── Main exported function ────────────────────────────────

/**
 * Finds the top semantically matched candidates for a given seeker profile
 * using MongoDB Atlas Hybrid Search ($rankFusion over up to 4 chunk vectors).
 *
 * Hard constraints (gender, status, readiness, age) are enforced INSIDE each
 * Atlas $vectorSearch via the `filter` parameter — Atlas evaluates them at
 * index scan time, before any vector similarity scoring.  This means
 * wrong-gender or out-of-age-range candidates never enter the ANN pool and
 * CANNOT surface in results regardless of vector similarity.
 *
 * @param seekerProfile  The internal candidate whose profile we search with.
 *                       Must have been embedded (embedding chunks present in DB).
 *                       Vectors themselves are loaded internally via a separate
 *                       DB read — they do not need to be on the passed object.
 * @param options        Optional: limit (default 5), numCandidates override.
 * @returns              Ranked list, best semantic match first.  Empty if the
 *                       seeker has no embedding, EMBEDDINGS_ENABLED is false,
 *                       or no candidates satisfy the hard constraints.
 */
export async function findTopSemanticallyMatchedCandidates(
  seekerProfile: IInternalCandidate,
  options: SimilaritySearchOptions = {},
): Promise<RankedCandidate[]> {

  // ── Guard: embeddings feature flag ───────────────────────────────────
  if (!env.EMBEDDINGS_ENABLED) {
    return [];
  }

  const limit    = options.limit ?? 5;
  const seekerId = (seekerProfile._id as Types.ObjectId).toString();

  // ── Step 1: Load seeker's query vectors ──────────────────────────────
  //
  // Vectors are stored select:false in the DB — loadChunksForQuery issues
  // a targeted find() with explicit +select paths to retrieve only the
  // four vector arrays.  No full document read is needed here.

  const queryVectors: CandidateChunks = await loadChunksForQuery(seekerId, 'internal');

  // Determine which chunk vectors are actually present.
  // A newly created profile may have some or no chunks embedded yet.
  const availableChunks = ALL_CHUNK_TYPES.filter(
    (c): c is ChunkType => queryVectors[c] != null,
  );

  if (availableChunks.length === 0) {
    // Expected for profiles created before the backfill has run.
    // The compatibility service should fall back to a non-semantic sort.
    log.warn({ seekerId }, 'No embedding chunks found — vector search cannot run.');
    return [];
  }

  // ── Step 2: Normalise chunk weights across available chunks ──────────
  //
  // If only a subset of chunks is available (e.g., the 'background' chunk
  // hasn't been generated yet), we redistribute the total weight across
  // the chunks we DO have.  This ensures the score scale is consistent
  // regardless of how many chunks are present.
  //
  // Example: only 'religious' (0.40) and 'expectations' (0.30) available.
  //   rawSum = 0.70
  //   normalised weights: religious = 0.40/0.70 ≈ 0.571, expectations ≈ 0.429

  const rawWeightSum = availableChunks.reduce((sum, c) => sum + CHUNK_WEIGHTS[c], 0);

  const normalisedWeights = Object.fromEntries(
    availableChunks.map(c => [c, CHUNK_WEIGHTS[c] / rawWeightSum]),
  ) as Partial<Record<ChunkType, number>>;

  // ── Step 3: Build the Atlas $vectorSearch pre-filter ─────────────────
  //
  // Passed to EVERY sub-pipeline.  Atlas evaluates this inside the vector
  // index scan — documents failing the filter are never scored.
  //
  // ⚠  Atlas $vectorSearch filter supports only simple MQL comparison
  //    operators ($eq, $ne, $gt, $lt, $gte, $lte, $in, $nin, $and, $or).
  //    No $expr, no $where, no $elemMatch on sub-arrays.
  //    Every filtered field must be declared as { "type": "filter" } in
  //    the Atlas vector index definition.

  const vectorSearchFilter = buildVectorSearchFilter(seekerProfile);

  // ── Step 4: Build per-chunk sub-pipelines ────────────────────────────
  //
  // Each sub-pipeline is a single $vectorSearch stage querying its own
  // dedicated Atlas index.  Atlas runs all sub-pipelines in parallel,
  // then $rankFusion merges their ranked result sets via weighted RRF.

  // How many candidates each sub-pipeline returns into the fusion pool.
  // SEMANTIC_TOP_K controls how wide the pool is before the compatibility
  // engine applies its own scoring.
  const subPipelineLimit = env.SEMANTIC_TOP_K;

  // numCandidates: how many ANN candidates the index considers internally
  // before the pre-filter narrows them to `limit`.  Must be ≥ 10× limit.
  const numCandidates = options.numCandidates
    ?? Math.min(subPipelineLimit * ANN_CANDIDATES_MULTIPLIER, MAX_ANN_CANDIDATES);

  const pipelines: Partial<Record<ChunkType, VectorSearchStage[]>> = {};
  const weights:   Partial<Record<ChunkType, number>>               = {};

  for (const chunkType of availableChunks) {
    const queryVector = queryVectors[chunkType];
    if (!queryVector) continue;  // narrowing — already filtered above

    pipelines[chunkType] = [
      {
        $vectorSearch: {
          index:         VECTOR_INDEX[chunkType],
          path:          `embedding.${chunkType}.vector`,
          queryVector,
          numCandidates,
          limit:         subPipelineLimit,
          filter:        vectorSearchFilter,
        },
      },
    ];

    weights[chunkType] = normalisedWeights[chunkType];
  }

  // ── Step 5: Assemble the full aggregation pipeline ───────────────────

  const rankFusionStage: RankFusionStage = {
    $rankFusion: {
      input:       { pipelines },
      combination: { weights },
    },
  };

  //  Pipeline execution order (all stages run in Atlas):
  //
  //  ① $rankFusion  — runs the 4 sub-pipelines, merges via weighted RRF,
  //                    outputs documents sorted by fusedScore descending.
  //                    Score is accessible as $meta 'rankFusionScore' in
  //                    subsequent stages.
  //
  //  ② $match       — safety net for stale-index scenarios: re-asserts
  //                    gender, status, and excludes the seeker themselves.
  //                    The pre-filter inside $vectorSearch is the primary
  //                    guard; this is the belt-and-suspenders check.
  //
  //  ③ $addFields   — materialises the Atlas metadata score into a normal
  //                    document field (_searchScore) so $sort and the
  //                    caller can both read it without repeating $meta.
  //
  //  ④ $sort        — orders by _searchScore descending (Atlas already
  //                    outputs in score order, but an explicit $sort is
  //                    required to preserve it through the $match stage).
  //
  //  ⑤ $limit       — returns only the requested shortlist size.

  const oppositeGender = seekerProfile.gender === Gender.MALE ? Gender.FEMALE : Gender.MALE;

  const pipeline = [
    rankFusionStage,
    {
      $match: {
        gender: oppositeGender,
        status: CandidateStatus.ACTIVE,
        // Exclude the seeker from results — shouldn't happen in practice
        // (gender filter rules it out) but guards against data anomalies.
        _id: { $ne: seekerProfile._id },
      },
    },
    {
      // $meta: 'rankFusionScore' is Atlas-specific — it reads the fused RRF
      // score that $rankFusion attached to each document as metadata.
      // Materialising it into _searchScore lets us sort by a normal field.
      $addFields: { _searchScore: { $meta: 'rankFusionScore' } },
    },
    {
      $sort: { _searchScore: -1 },
    },
    {
      $limit: limit,
    },
  ];

  // ── Step 6: Execute with timeout protection ──────────────────────────

  type RawResult = IInternalCandidate & { _searchScore?: number };
  let rawResults: RawResult[];

  try {
    // Cast pipeline to `unknown[]` because Mongoose's PipelineStage union
    // does not include $rankFusion (Atlas-only operator) or $meta variants
    // beyond 'textScore'/'indexKey'.  The runtime payload is correct.
    rawResults = await InternalCandidate
      // Double-cast: $rankFusion and the 'rankFusionScore' $meta variant
      // are Atlas-only and absent from Mongoose's PipelineStage union.
      // The runtime payload is correct; the cast is purely a type-system bypass.
      .aggregate<RawResult>(pipeline as unknown as import('mongoose').PipelineStage[])
      .option({ maxTimeMS: PIPELINE_TIMEOUT_MS })
      .exec();

  } catch (err) {
    const isTimeout =
      err instanceof Error && err.message.toLowerCase().includes('exceeded time limit');

    log.error({
      seekerId,
      availableChunks,
      timeoutMs: PIPELINE_TIMEOUT_MS,
      error: String(err),
    }, isTimeout ? 'pipeline_timeout' : 'pipeline_error');

    // Re-throw so the compatibility service can fall back to a non-semantic
    // result set rather than silently returning an empty list.
    throw err;
  }

  if (rawResults.length === 0) {
    log.info({
      seekerId,
      availableChunks,
      hint: 'Check that Atlas indexes exist, filter fields are declared, and at least one eligible candidate is embedded.',
    }, 'empty_result');
    return [];
  }

  log.info({
    seekerId,
    availableChunks,
    normalisedWeights,
    resultsCount: rawResults.length,
    topScore: rawResults[0]?._searchScore ?? 0,
    bottomScore: rawResults[rawResults.length - 1]?._searchScore ?? 0,
  }, 'search_complete');

  // Strip the internal _searchScore field from the candidate object before
  // returning — it lives on RankedCandidate.score, not on the document.
  return rawResults.map(({ _searchScore, ...candidateDoc }) => ({
    candidate: candidateDoc as unknown as IInternalCandidate,
    score:     _searchScore ?? 0,
  }));
}

// ── Helper: build the $vectorSearch pre-filter ────────────

/**
 * Constructs the MQL filter applied INSIDE every $vectorSearch sub-pipeline.
 *
 * All conditions here are HARD constraints — a candidate that fails any
 * one of them cannot appear in the result set.  This function should only
 * encode rules that are universally valid for ALL seekers (gender polarity,
 * availability status, basic readiness).
 *
 * Seeker-specific preferences (sector openness, divorced/children openness,
 * etc.) are intentionally NOT encoded here — they are soft signals handled
 * by the compatibility engine after the semantic shortlist is built.
 *
 * ⚠  All fields referenced here must be declared as { "type": "filter" }
 *    in each Atlas vector index definition.
 */
function buildVectorSearchFilter(seeker: IInternalCandidate): Record<string, unknown> {
  const oppositeGender =
    seeker.gender === Gender.MALE ? Gender.FEMALE : Gender.MALE;

  const filter: Record<string, unknown> = {

    // ── Gender (hard rule) ──────────────────────────────────────────
    // We match opposite gender by default.  If the system ever needs to
    // support same-gender matching, this constraint becomes configurable.
    gender: { $eq: oppositeGender },

    // ── Availability status (hard rule) ────────────────────────────
    // Only ACTIVE candidates receive new suggestions.  PAUSED candidates
    // are intentionally excluded — they opted out of the suggestion flow.
    status: { $eq: CandidateStatus.ACTIVE },

    // ── Readiness for marriage (hard rule) ─────────────────────────
    // Only candidates who are actively looking or open to proposals.
    // EXPLORING / NOT_READY / ON_HOLD indicate the candidate is not
    // ready for a concrete suggestion; including them wastes the
    // shadchan's time and disrespects the candidate's stated preference.
    readinessForMarriage: { $in: ELIGIBLE_READINESS },
  };

  // ── Age bounds (derived from seeker's agePreferences) ────────────
  //
  // InternalCandidate stores dateOfBirth (Date), not age (Number).
  // We convert the seeker's age preference range to birth-date bounds:
  //
  //   "I want candidates aged at least MIN years old"
  //     → their birthday must be BEFORE or ON Dec 31 of (now.year − MIN)
  //     → filter: dateOfBirth { $lte: Dec 31 of (year − MIN) }
  //
  //   "I want candidates aged at most MAX years old"
  //     → their birthday must be AFTER or ON Jan 1 of (now.year − MAX)
  //     → filter: dateOfBirth { $gte: Jan 1 of (year − MAX) }
  //
  // If a preference bound is absent, we omit that side of the range —
  // never imposing an artificial cap the seeker didn't request.

  const currentYear = new Date().getFullYear();
  const dobFilter: Record<string, Date> = {};

  if (seeker.agePreferences?.min != null) {
    // Candidate must be at least MIN years old → born ≤ end of (year − MIN)
    const latestBirthYear = currentYear - seeker.agePreferences.min;
    dobFilter['$lte'] = new Date(`${latestBirthYear}-12-31T23:59:59.999Z`);
  }

  if (seeker.agePreferences?.max != null) {
    // Candidate must be at most MAX years old → born ≥ start of (year − MAX)
    const earliestBirthYear = currentYear - seeker.agePreferences.max;
    dobFilter['$gte'] = new Date(`${earliestBirthYear}-01-01T00:00:00.000Z`);
  }

  if (Object.keys(dobFilter).length > 0) {
    filter['dateOfBirth'] = dobFilter;
  }

  return filter;
}
