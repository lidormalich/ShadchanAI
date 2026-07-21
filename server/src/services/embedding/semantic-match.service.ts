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
  perChunkSimilarities,
} from './semantic-similarity.service.js';
import type { ChunkType } from './embedding.types.js';
import { inferGender } from '../extraction/templates.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('semantic.match');

// Same ceiling the deterministic board uses — bounds the vector fetch.
const SEMANTIC_POOL_CAP = 500;
const DEFAULT_LIMIT = 50;
// Matches SUSPECT_MIN_WEIGHT in insights — below this the text signal
// is too weak to overrule the stored tag.
const GENDER_SUSPECT_MIN_WEIGHT = 2;

// ── "Why similar" highlights ──────────────────────────────
// Short, deterministic reason chips per ranked row: which profile
// chunk drives the similarity + hard-attribute alignments. No AI
// call — computed for the top rows only, from data already in hand.

const CHUNK_HIGHLIGHT_LABEL: Record<ChunkType, string> = {
  religious: 'השקפה דתית דומה',
  expectations: 'ציפיות דומות',
  personality: 'אופי דומה',
  background: 'רקע דומה',
};
// Same floor the engine uses for its semantic boost (matching.score.ts).
const CHUNK_HIGHLIGHT_MIN = 0.72;
const MAX_HIGHLIGHTS = 4;
const AGE_GAP_HIGHLIGHT_MAX = 3;

interface HighlightProfile {
  age?: number;
  city?: string;
  region?: string;
  sectorGroup?: string;
  religiousStyle?: string;
  lifestyleTone?: string;
}

function buildHighlights(
  internal: HighlightProfile,
  ext: HighlightProfile,
  chunkSims: Partial<Record<ChunkType, number>>,
): string[] {
  const out: string[] = [];

  // Strongest text chunks first — that's what the vector rank "saw".
  const topChunks = (Object.entries(chunkSims) as Array<[ChunkType, number]>)
    .filter(([, sim]) => sim >= CHUNK_HIGHLIGHT_MIN)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  for (const [chunk] of topChunks) out.push(CHUNK_HIGHLIGHT_LABEL[chunk]);

  if (internal.age != null && ext.age != null) {
    const gap = Math.abs(internal.age - ext.age);
    if (gap === 0) out.push('אותו גיל');
    else if (gap <= AGE_GAP_HIGHLIGHT_MAX) out.push(`פער גיל ${gap}`);
  }
  if (internal.city && ext.city && internal.city.trim() === ext.city.trim()) {
    out.push('אותה עיר');
  } else if (internal.region && ext.region && internal.region === ext.region) {
    out.push('אותו אזור');
  }
  if (internal.sectorGroup && ext.sectorGroup && internal.sectorGroup === ext.sectorGroup) {
    out.push('אותו מגזר');
  }
  if (
    out.length < MAX_HIGHLIGHTS &&
    internal.religiousStyle && ext.religiousStyle &&
    internal.religiousStyle === ext.religiousStyle
  ) {
    out.push('סגנון דתי זהה');
  }
  if (
    out.length < MAX_HIGHLIGHTS &&
    internal.lifestyleTone && ext.lifestyleTone &&
    internal.lifestyleTone === ext.lifestyleTone
  ) {
    out.push('סגנון חיים זהה');
  }

  return out.slice(0, MAX_HIGHLIGHTS);
}

function ageFromDateOfBirth(dob?: Date): number | undefined {
  if (!dob) return undefined;
  const ms = Date.now() - new Date(dob).getTime();
  if (ms <= 0) return undefined;
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
}

export interface SemanticMatchRow {
  externalCandidateId: string;
  firstName?: string;
  lastName?: string;
  /** Auth-gated proxy URL of the candidate photo, if one exists. */
  photoUrl?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  personalStatus?: string;
  availabilityStatus?: string;
  /** Weighted cosine similarity, 0..1 (higher = closer profile text). */
  similarity: number;
  /** Short "why similar" reason chips (deterministic, no AI). */
  highlights: string[];
  /** Deterministic engine score from the PairScore cache, if scanned. */
  matchScore?: number;
  engineEligible?: boolean;
  /** Hard-blocker codes from the cache — populated only when engineEligible is false. */
  blockerCodes?: string[];
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
    /** Dropped because their free text reads as the WRONG gender (mis-tagged data). */
    genderSuspectsExcluded: number;
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
    coverage: { externalsConsidered: 0, externalsEmbedded: 0, genderSuspectsExcluded: 0 },
    rows: [],
  };

  if (!(await isSemanticEnabled())) return base;
  base.enabled = true;

  const internal = await InternalCandidate.findById(internalId)
    .select('gender dateOfBirth city region sectorGroup religiousStyle lifestyleTone')
    .lean()
    .exec();
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);

  const internalProfile: HighlightProfile = {
    age: ageFromDateOfBirth(internal['dateOfBirth'] as Date | undefined),
    city: internal['city'] as string | undefined,
    region: internal['region'] as string | undefined,
    sectorGroup: internal['sectorGroup'] as string | undefined,
    religiousStyle: internal['religiousStyle'] as string | undefined,
    lifestyleTone: internal['lifestyleTone'] as string | undefined,
  };

  const oppositeGender = internal.gender === 'male' ? 'female' : 'male';

  // Pool mirrors the deterministic board: active, plausibly available.
  const pool = await ExternalCandidate.find({
    gender: oppositeGender,
    status: 'active',
    availabilityStatus: { $in: ['available', 'unknown'] },
  })
    .select(
      'firstName lastName photoUrl age city region sectorGroup religiousStyle lifestyleTone ' +
        'personalStatus availabilityStatus about additionalInfo characterNotes currentOccupation',
    )
    .sort({ createdAt: -1 })
    .limit(SEMANTIC_POOL_CAP)
    .lean()
    .exec();

  // Second gender gate: the stored tag says opposite, but WhatsApp
  // extraction mis-tags some profiles — if the free text clearly reads
  // as the internal's OWN gender, drop the row (same signal/threshold
  // as the insights suspect detector).
  const externals = pool.filter((e) => {
    const text = [e['about'], e['additionalInfo'], e['characterNotes'], e['currentOccupation']]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!text) return true;
    const sig = inferGender(text);
    if (!sig.gender || sig.gender === oppositeGender) return true;
    const winning = sig.gender === 'male' ? sig.maleWeight : sig.femaleWeight;
    if (winning < GENDER_SUSPECT_MIN_WEIGHT) return true;
    base.coverage.genderSuspectsExcluded += 1;
    return false;
  });

  if (base.coverage.genderSuspectsExcluded > 0) {
    log.warn(
      { internalId, excluded: base.coverage.genderSuspectsExcluded },
      'semantic_pool_gender_suspects_excluded',
    );
  }

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
    .select('externalCandidateId matchScore eligible blockerCodes')
    .lean()
    .exec();
  const scoreByExternal = new Map(
    pairScores.map((p) => [String(p.externalCandidateId), p]),
  );

  base.rows = ranked.map(({ ext, sim }) => {
    const cached = scoreByExternal.get(String(ext._id));
    const extId = String(ext._id);
    const extProfile: HighlightProfile = {
      age: ext['age'] as number | undefined,
      city: ext['city'] as string | undefined,
      region: ext['region'] as string | undefined,
      sectorGroup: ext['sectorGroup'] as string | undefined,
      religiousStyle: ext['religiousStyle'] as string | undefined,
      lifestyleTone: ext['lifestyleTone'] as string | undefined,
    };
    const extChunks = externalChunks.get(extId);
    const chunkSims = extChunks ? perChunkSimilarities(internalChunks, extChunks) : {};
    return {
      externalCandidateId: extId,
      firstName: ext['firstName'] as string | undefined,
      lastName: ext['lastName'] as string | undefined,
      photoUrl: ext['photoUrl'] as string | undefined,
      age: extProfile.age,
      city: extProfile.city,
      sectorGroup: extProfile.sectorGroup,
      personalStatus: ext['personalStatus'] as string | undefined,
      availabilityStatus: ext['availabilityStatus'] as string | undefined,
      similarity: Math.round(sim * 1000) / 1000,
      highlights: buildHighlights(internalProfile, extProfile, chunkSims),
      matchScore: cached?.matchScore,
      engineEligible: cached?.eligible,
      blockerCodes: cached && !cached.eligible ? (cached.blockerCodes ?? []) : undefined,
    };
  });

  return base;
}
