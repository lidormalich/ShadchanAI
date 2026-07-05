// ═══════════════════════════════════════════════════════════
// ShadchanAI — Semantic Similarity (Node-side cosine)
//
// Computes internal↔external semantic similarity directly in Node
// from the stored chunk vectors — NO Atlas vector indexes required,
// so the add-on works on any MongoDB deployment.
//
// Per pair: weighted cosine over the chunks BOTH candidates have
// (weights from CHUNK_WEIGHTS, renormalised over shared chunks).
// bge-m3 and text-embedding-3-* are both trained for cosine, and the
// result lands in the same 0..1 scale the engine's flexibility
// dimension expects (boost above 0.7 — matching.score.ts).
//
// Consumers set the result on MatchingContext.semanticSimilarities;
// the deterministic engine reads it as an optional signal and works
// unchanged when the map is absent (add-on off / vectors missing).
//
// Scale note: cosine over the ~300-external board pool is ~1ms-class
// CPU work. The bulk scan prefetches external vectors once (capped)
// and reuses them across internals — see match-scan.service.ts.
// ═══════════════════════════════════════════════════════════

import { InternalCandidate, ExternalCandidate } from '../../models/index.js';
import { loadChunksForQuery, ensureAllChunks } from './embedding.service.js';
import { ALL_CHUNK_TYPES, CHUNK_WEIGHTS } from './embedding.types.js';
import type { CandidateChunks, ChunkType } from './embedding.types.js';
import { isSemanticEnabled } from './embedding.gate.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('semantic.similarity');

// ── Pure math ─────────────────────────────────────────────

function cosine(a: number[], b: number[]): number | undefined {
  if (a.length === 0 || a.length !== b.length) return undefined;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return undefined;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Weighted cosine similarity across the chunks BOTH sides have.
 * Weights are renormalised over the shared subset so a candidate
 * missing e.g. the personality chunk isn't penalised — they just
 * contribute less signal. Returns undefined when no chunk overlaps.
 * Clamped to 0..1 (cosine can dip slightly negative on unrelated text).
 */
export function weightedChunkSimilarity(
  a: CandidateChunks,
  b: CandidateChunks,
): number | undefined {
  let weightSum = 0;
  let acc = 0;
  for (const chunk of ALL_CHUNK_TYPES) {
    const va = a[chunk];
    const vb = b[chunk];
    if (!va || !vb) continue;
    const sim = cosine(va, vb);
    if (sim === undefined) continue;
    acc += sim * CHUNK_WEIGHTS[chunk];
    weightSum += CHUNK_WEIGHTS[chunk];
  }
  if (weightSum === 0) return undefined;
  return Math.min(1, Math.max(0, acc / weightSum));
}

/**
 * Per-chunk cosine breakdown for one pair — powers the "why similar"
 * highlights on the semantic ranking (which PART of the profiles is
 * close, not just the blended score). Clamped to 0..1 like the
 * weighted total.
 */
export function perChunkSimilarities(
  a: CandidateChunks,
  b: CandidateChunks,
): Partial<Record<ChunkType, number>> {
  const out: Partial<Record<ChunkType, number>> = {};
  for (const chunk of ALL_CHUNK_TYPES) {
    const va = a[chunk];
    const vb = b[chunk];
    if (!va || !vb) continue;
    const sim = cosine(va, vb);
    if (sim !== undefined) out[chunk] = Math.min(1, Math.max(0, sim));
  }
  return out;
}

// ── Vector loading ────────────────────────────────────────

const VECTOR_SELECT = ALL_CHUNK_TYPES.map((c) => `+embedding.${c}.vector`).join(' ');

type LeanEmbedding = {
  embedding?: {
    religious?:    { vector?: number[] };
    expectations?: { vector?: number[] };
    personality?:  { vector?: number[] };
    background?:   { vector?: number[] };
  };
};

function toChunks(doc: LeanEmbedding): CandidateChunks {
  const emb = doc.embedding;
  return {
    religious:    emb?.religious?.vector    ?? undefined,
    expectations: emb?.expectations?.vector ?? undefined,
    personality:  emb?.personality?.vector  ?? undefined,
    background:   emb?.background?.vector   ?? undefined,
  };
}

/**
 * Batch-load chunk vectors for a set of externals. Candidates with no
 * vectors at all are omitted from the map (they simply get no semantic
 * signal — never an error).
 */
export async function loadExternalChunksMap(
  externalIds: string[],
): Promise<Map<string, CandidateChunks>> {
  const out = new Map<string, CandidateChunks>();
  if (externalIds.length === 0) return out;

  const docs = await ExternalCandidate
    .find({ _id: { $in: externalIds }, 'embedding.modelId': { $exists: true } })
    .select(VECTOR_SELECT)
    .lean()
    .exec();

  for (const doc of docs) {
    const chunks = toChunks(doc as LeanEmbedding);
    if (ALL_CHUNK_TYPES.some((c) => chunks[c])) {
      out.set(String((doc as { _id: unknown })._id), chunks);
    }
  }
  return out;
}

/**
 * Pure fan-out: similarity of one internal's chunks against a
 * prefetched external-vector map. Returns undefined when there is
 * nothing to compare (keeps MatchingContext.semanticSimilarities
 * absent rather than empty).
 */
export function similarityMapFromChunks(
  internalChunks: CandidateChunks,
  externalChunks: Map<string, CandidateChunks>,
): Map<string, number> | undefined {
  if (!ALL_CHUNK_TYPES.some((c) => internalChunks[c])) return undefined;

  const out = new Map<string, number>();
  for (const [externalId, chunks] of externalChunks) {
    const sim = weightedChunkSimilarity(internalChunks, chunks);
    if (sim !== undefined) out.set(externalId, sim);
  }
  return out.size > 0 ? out : undefined;
}

// ── High-level entry point (board / single pair) ──────────

/**
 * Builds the externalId → similarity map for one internal against a
 * given pool of externals. Gate-checked and fail-soft: any error (or
 * the add-on being off) yields undefined and the deterministic engine
 * proceeds untouched.
 *
 * When the internal has no vectors yet, a background embed is kicked
 * off so the NEXT load has semantic signal — this makes the admin
 * toggle self-serve with no manual backfill step.
 */
export async function buildSemanticSimilarityMap(
  internalId: string,
  externalIds: string[],
): Promise<Map<string, number> | undefined> {
  if (externalIds.length === 0) return undefined;

  try {
    if (!(await isSemanticEnabled())) return undefined;

    const internalChunks = await loadChunksForQuery(internalId, 'internal');
    if (!ALL_CHUNK_TYPES.some((c) => internalChunks[c])) {
      void ensureAllChunks(internalId, 'internal').catch((err) => {
        log.warn({ internalId, error: String(err) }, 'lazy_internal_embed_failed');
      });
      return undefined;
    }

    const externalChunks = await loadExternalChunksMap(externalIds);
    return similarityMapFromChunks(internalChunks, externalChunks);
  } catch (err) {
    // Semantic signal is an enhancement — scoring must never fail on it.
    log.warn({ internalId, error: String(err) }, 'similarity_map_failed');
    return undefined;
  }
}

// ── Scan-time lazy embedding ──────────────────────────────

// Per-scan cap on how many candidates get freshly embedded, so turning
// the toggle on doesn't stall the first scan behind hundreds of API
// calls. Remaining candidates are picked up by subsequent scans (the
// scan runs incrementally anyway) — coverage converges in a few runs.
const MAX_EMBED_PER_SCAN = 200;
const EMBED_CONCURRENCY = 4;

/**
 * Ensures embeddings exist for candidates entering a scan, capped per
 * run. Only candidates with NO embedding at all are targeted here —
 * per-field staleness is handled by the PATCH hook
 * (scheduleChunkInvalidation). Returns counts for the scan log.
 */
export async function ensureEmbeddingsForScan(
  internalIds: string[],
  externalIds: string[],
): Promise<{ embedded: number; remaining: number }> {
  const [missingInternals, missingExternals] = await Promise.all([
    InternalCandidate
      .find({ _id: { $in: internalIds }, 'embedding.modelId': { $exists: false } })
      .select('_id').lean().exec(),
    ExternalCandidate
      .find({ _id: { $in: externalIds }, 'embedding.modelId': { $exists: false } })
      .select('_id').lean().exec(),
  ]);

  const targets: Array<{ id: string; type: 'internal' | 'external' }> = [
    ...missingInternals.map((d) => ({ id: String(d._id), type: 'internal' as const })),
    ...missingExternals.map((d) => ({ id: String(d._id), type: 'external' as const })),
  ];

  const batch = targets.slice(0, MAX_EMBED_PER_SCAN);
  let embedded = 0;

  for (let i = 0; i < batch.length; i += EMBED_CONCURRENCY) {
    const slice = batch.slice(i, i + EMBED_CONCURRENCY);
    const results = await Promise.allSettled(
      slice.map((t) => ensureAllChunks(t.id, t.type)),
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j]!.status === 'fulfilled') {
        embedded++;
      } else {
        const r = results[j] as PromiseRejectedResult;
        log.warn({ ...slice[j], error: String(r.reason) }, 'scan_embed_failed');
      }
    }
  }

  const remaining = targets.length - batch.length;
  if (embedded > 0 || remaining > 0) {
    log.info({ embedded, remaining, capped: remaining > 0 }, 'scan_embed_pass');
  }
  return { embedded, remaining };
}
