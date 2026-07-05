// ═══════════════════════════════════════════════════════════
// ShadchanAI — Semantic Matches ("הצעה חכמה" tab)
//
// Ranked list of external candidates for one internal, ordered by
// pure vector similarity (weighted cosine over the profile chunks) —
// deliberately independent of the deterministic engine's score, so
// the operator sees what the TEXT says, not what the rules say.
// Engine scores from the PairScore cache are attached as context
// where available, never as the ranking key.
//
// Hard floors that stay non-negotiable: opposite gender + active
// status (applied in the pool query). Everything else is up to the
// similarity ranking.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { InternalCandidate, ExternalCandidate, PairScore } from '../../models/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { loadChunksForQuery, ensureAllChunks } from './embedding.service.js';
import { ALL_CHUNK_TYPES } from './embedding.types.js';
import { isSemanticEnabled } from './embedding.gate.js';
import {
  loadExternalChunksMap,
  similarityMapFromChunks,
} from './semantic-similarity.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('semantic.match');

// Same ceiling the deterministic board uses — bounds the vector fetch.
const SEMANTIC_POOL_CAP = 500;
const DEFAULT_LIMIT = 50;

export interface SemanticMatchRow {
  externalCandidateId: string;
  firstName?: string;
  lastName?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  personalStatus?: string;
  availabilityStatus?: string;
  /** Weighted cosine similarity, 0..1 (higher = closer profile text). */
  similarity: number;
  /** Deterministic engine score from the PairScore cache, if scanned. */
  matchScore?: number;
  engineEligible?: boolean;
}

export interface SemanticMatchesResult {
  enabled: boolean;
  internalCandidateId: string;
  /** False while the internal's own vectors are still being generated. */
  internalEmbedded: boolean;
  generatedAt: string;
  coverage: {
    externalsConsidered: number;
    externalsEmbedded: number;
  };
  rows: SemanticMatchRow[];
}

export async function getSemanticMatchesForInternal(
  internalId: string,
  limit = DEFAULT_LIMIT,
): Promise<SemanticMatchesResult> {
  const base: SemanticMatchesResult = {
    enabled: false,
    internalCandidateId: internalId,
    internalEmbedded: false,
    generatedAt: new Date().toISOString(),
    coverage: { externalsConsidered: 0, externalsEmbedded: 0 },
    rows: [],
  };

  if (!(await isSemanticEnabled())) return base;
  base.enabled = true;

  const internal = await InternalCandidate.findById(internalId)
    .select('gender')
    .lean()
    .exec();
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);

  const oppositeGender = internal.gender === 'male' ? 'female' : 'male';

  // Pool mirrors the deterministic board: active, plausibly available.
  const externals = await ExternalCandidate.find({
    gender: oppositeGender,
    status: 'active',
    availabilityStatus: { $in: ['available', 'unknown'] },
  })
    .select('firstName lastName age city sectorGroup personalStatus availabilityStatus')
    .sort({ createdAt: -1 })
    .limit(SEMANTIC_POOL_CAP)
    .lean()
    .exec();

  base.coverage.externalsConsidered = externals.length;

  const internalChunks = await loadChunksForQuery(internalId, 'internal');
  base.internalEmbedded = ALL_CHUNK_TYPES.some((c) => internalChunks[c]);
  if (!base.internalEmbedded) {
    // Kick a background embed so a refresh (or the backfill button)
    // fills the gap — the tab shows a "not embedded yet" hint meanwhile.
    void ensureAllChunks(internalId, 'internal').catch((err) => {
      log.warn({ internalId, error: String(err) }, 'lazy_internal_embed_failed');
    });
    return base;
  }

  const externalIds = externals.map((e) => String(e._id));
  const externalChunks = await loadExternalChunksMap(externalIds);
  base.coverage.externalsEmbedded = externalChunks.size;

  const similarity = similarityMapFromChunks(internalChunks, externalChunks);
  if (!similarity) return base;

  const ranked = externals
    .filter((e) => similarity.has(String(e._id)))
    .map((e) => ({ ext: e, sim: similarity.get(String(e._id))! }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);

  // Attach cached engine scores for context (single batched read).
  const pairScores = await PairScore.find({
    internalCandidateId: new Types.ObjectId(internalId),
    externalCandidateId: { $in: ranked.map((r) => new Types.ObjectId(String(r.ext._id))) },
  })
    .select('externalCandidateId matchScore eligible')
    .lean()
    .exec();
  const scoreByExternal = new Map(
    pairScores.map((p) => [String(p.externalCandidateId), p]),
  );

  base.rows = ranked.map(({ ext, sim }) => {
    const cached = scoreByExternal.get(String(ext._id));
    return {
      externalCandidateId: String(ext._id),
      firstName: ext['firstName'] as string | undefined,
      lastName: ext['lastName'] as string | undefined,
      age: ext['age'] as number | undefined,
      city: ext['city'] as string | undefined,
      sectorGroup: ext['sectorGroup'] as string | undefined,
      personalStatus: ext['personalStatus'] as string | undefined,
      availabilityStatus: ext['availabilityStatus'] as string | undefined,
      similarity: Math.round(sim * 1000) / 1000,
      matchScore: cached?.matchScore,
      engineEligible: cached?.eligible,
    };
  });

  return base;
}
