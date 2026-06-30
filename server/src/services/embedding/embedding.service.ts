// ═══════════════════════════════════════════════════════════
// ShadchanAI — Embedding Service
//
// Orchestrates the full lifecycle of candidate chunk embeddings:
//   • ensureAllChunks  — generate + save any missing/stale chunks
//   • loadChunksForQuery — fetch vectors from DB for similarity search
//   • invalidateChunks  — mark specific chunks stale after profile edits
//   • scheduleChunkRefresh — fire-and-forget re-embed after invalidation
//
// Interaction pattern:
//
//   Controller (on PATCH):
//     invalidateChunks(id, type, affectedChunkTypes)
//     scheduleChunkRefresh(id, type, affectedChunkTypes)   ← async, non-blocking
//
//   Backfill script:
//     ensureAllChunks(id, type, doc)   ← for each candidate
//
//   Similarity service (on board load):
//     loadChunksForQuery(id, 'internal')   ← only reads, never writes
//
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { InternalCandidate, ExternalCandidate } from '../../models/index.js';
import type { IInternalCandidate } from '../../modules/candidates/internal-candidate.model.js';
import type { IExternalCandidate } from '../../modules/candidates/external-candidate.model.js';
import { getEmbeddingProvider } from './embedding.provider.js';
import {
  serializeInternalChunks,
  serializeExternalChunks,
  serializeSingleChunk,
} from './profile.serializer.js';
import type {
  ChunkType,
  CandidateChunks,
  ChunkTexts,
} from './embedding.types.js';
import { ALL_CHUNK_TYPES } from './embedding.types.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('embedding.service');

// ── Types ─────────────────────────────────────────────────

type CandidateType = 'internal' | 'external';

// Minimal shape we need from the DB when checking whether chunks exist.
// We never load vectors here — only metadata.
interface EmbeddingMeta {
  modelId?: string;
  religious?:    { embeddedAt?: Date };
  expectations?: { embeddedAt?: Date };
  personality?:  { embeddedAt?: Date };
  background?:   { embeddedAt?: Date };
}

// ── Public API ────────────────────────────────────────────

/**
 * Ensures all 4 chunk vectors exist in the DB for the given candidate.
 *
 * For each chunk:
 *   1. If the vector is missing → embed and save.
 *   2. If the stored modelId differs from the current model → re-embed.
 *   3. If forceRefresh=true → re-embed regardless.
 *
 * @param doc  Optional already-loaded document.  Pass it to avoid an
 *             extra DB fetch (useful in the backfill script).
 */
export async function ensureAllChunks(
  candidateId: string,
  type: CandidateType,
  options: {
    forceRefresh?: boolean;
    doc?: IInternalCandidate | IExternalCandidate;
  } = {},
): Promise<void> {
  if (!env.EMBEDDINGS_ENABLED) return;

  const { forceRefresh = false } = options;

  // Load the candidate document (text fields) if not supplied.
  const doc = options.doc ?? await fetchDoc(candidateId, type, 'full');
  if (!doc) {
    log.warn({ candidateId, type }, 'doc_not_found');
    return;
  }

  // Load just the embedding metadata (no vectors) to check staleness.
  const meta = await fetchEmbeddingMeta(candidateId, type);
  const currentModelId = env.EMBEDDINGS_MODEL ?? 'BAAI/bge-m3';
  const modelChanged   = meta?.modelId !== currentModelId;

  // Determine which chunks need (re-)generating.
  const chunksToEmbed: ChunkType[] = ALL_CHUNK_TYPES.filter(chunkType => {
    if (forceRefresh) return true;
    if (modelChanged) return true;
    // Missing vector = no embeddedAt on the chunk sub-doc.
    return !meta?.[chunkType]?.embeddedAt;
  });

  if (chunksToEmbed.length === 0) return;  // All chunks are fresh.

  // Serialise only the chunks we need.
  const allTexts: ChunkTexts =
    type === 'internal'
      ? serializeInternalChunks(doc as IInternalCandidate)
      : serializeExternalChunks(doc as IExternalCandidate);

  // Filter to the chunks that have content AND need embedding.
  const toEmbed = chunksToEmbed
    .map(chunkType => ({ chunkType, text: allTexts[chunkType] }))
    .filter((x): x is { chunkType: ChunkType; text: string } => x.text !== null);

  if (toEmbed.length === 0) {
    log.info({ candidateId, type, skippedChunks: chunksToEmbed }, 'no_content');
    return;
  }

  // Batch all texts into a single API call for efficiency.
  const provider = getEmbeddingProvider();
  const vectors  = await provider.embed(toEmbed.map(x => x.text));

  // Persist each vector to the DB.
  const now = new Date();
  const $setFields: Record<string, unknown> = {
    'embedding.modelId':    provider.modelConfig.modelId,
    'embedding.provider':   provider.modelConfig.provider,
    'embedding.dimensions': provider.modelConfig.dimensions,
    'embedding.updatedAt':  now,
  };

  toEmbed.forEach(({ chunkType, text }, i) => {
    $setFields[`embedding.${chunkType}.vector`]       = vectors[i];
    $setFields[`embedding.${chunkType}.textSnapshot`] = text;
    $setFields[`embedding.${chunkType}.embeddedAt`]   = now;
  });

  await updateEmbedding(candidateId, type, $setFields);

  log.info({
    candidateId,
    type,
    chunks: toEmbed.map(x => x.chunkType),
    model: provider.modelConfig.modelId,
  }, 'chunks_saved');
}

/**
 * Loads the 4 chunk vectors from the DB for use as query vectors in
 * the Atlas similarity search.
 *
 * Vectors are stored with `select: false` and must be explicitly
 * requested.  Returns undefined for any chunk whose vector is absent.
 */
export async function loadChunksForQuery(
  candidateId: string,
  type: CandidateType,
): Promise<CandidateChunks> {
  // Build the explicit +select paths for all 4 chunk vectors.
  const selectPaths = ALL_CHUNK_TYPES
    .map(c => `+embedding.${c}.vector`)
    .join(' ');

  const Model = type === 'internal' ? InternalCandidate : ExternalCandidate;
  const doc = await (Model as typeof InternalCandidate)
    .findById(candidateId)
    .select(selectPaths)
    .lean()
    .exec();

  if (!doc?.embedding) {
    return {};
  }

  // Cast to a named-key type so TypeScript allows dot-access without
  // triggering the "index signature — use bracket notation" rule (TS4111).
  type EmbChunks = {
    religious?:    { vector?: number[] };
    expectations?: { vector?: number[] };
    personality?:  { vector?: number[] };
    background?:   { vector?: number[] };
  };
  const emb = doc.embedding as EmbChunks;
  return {
    religious:    emb.religious?.vector    ?? undefined,
    expectations: emb.expectations?.vector ?? undefined,
    personality:  emb.personality?.vector  ?? undefined,
    background:   emb.background?.vector   ?? undefined,
  };
}

/**
 * Marks specific chunks as stale by removing their vectors.
 *
 * Call this from the controller immediately when profile fields change.
 * The vectors are deleted (not just dated) so that the next similarity
 * search is not polluted by outdated embeddings while the refresh runs.
 *
 * scheduleChunkRefresh() should be called right after to re-embed
 * asynchronously in the background.
 */
export async function invalidateChunks(
  candidateId: string,
  type: CandidateType,
  affectedChunks: ChunkType[],
): Promise<void> {
  if (affectedChunks.length === 0) return;

  const $unsetFields: Record<string, ''> = {};
  for (const chunkType of affectedChunks) {
    $unsetFields[`embedding.${chunkType}.vector`]       = '';
    $unsetFields[`embedding.${chunkType}.textSnapshot`] = '';
    $unsetFields[`embedding.${chunkType}.embeddedAt`]   = '';
  }

  await updateEmbedding(candidateId, type, {}, $unsetFields);

  log.info({ candidateId, type, chunks: affectedChunks }, 'chunks_invalidated');
}

/**
 * Fire-and-forget: re-embeds the specified chunks in the background.
 *
 * Designed to be called from controllers without awaiting:
 *   void scheduleChunkRefresh(id, 'internal', ['religious']);
 *
 * Errors are caught and logged — they must never propagate to the
 * HTTP response that triggered the profile update.
 */
export function scheduleChunkRefresh(
  candidateId: string,
  type: CandidateType,
  affectedChunks: ChunkType[],
): void {
  if (!env.EMBEDDINGS_ENABLED || affectedChunks.length === 0) return;

  // We re-embed only the affected chunks, not all 4.
  refreshSpecificChunks(candidateId, type, affectedChunks).catch(err => {
    log.error({ candidateId, type, affectedChunks, error: String(err) }, 'Background chunk refresh failed');
  });
}

// ── Internal helpers ──────────────────────────────────────

async function refreshSpecificChunks(
  candidateId: string,
  type: CandidateType,
  chunkTypes: ChunkType[],
): Promise<void> {
  const doc = await fetchDoc(candidateId, type, 'full');
  if (!doc) return;

  const provider = getEmbeddingProvider();

  // Serialise only the requested chunks.
  const toEmbed = chunkTypes
    .map(chunkType => ({
      chunkType,
      text: serializeSingleChunk(doc, chunkType, type),
    }))
    .filter((x): x is { chunkType: ChunkType; text: string } => x.text !== null);

  if (toEmbed.length === 0) return;

  const vectors = await provider.embed(toEmbed.map(x => x.text));
  const now = new Date();
  const $setFields: Record<string, unknown> = {
    'embedding.modelId':    provider.modelConfig.modelId,
    'embedding.provider':   provider.modelConfig.provider,
    'embedding.dimensions': provider.modelConfig.dimensions,
    'embedding.updatedAt':  now,
  };

  toEmbed.forEach(({ chunkType, text }, i) => {
    $setFields[`embedding.${chunkType}.vector`]       = vectors[i];
    $setFields[`embedding.${chunkType}.textSnapshot`] = text;
    $setFields[`embedding.${chunkType}.embeddedAt`]   = now;
  });

  await updateEmbedding(candidateId, type, $setFields);

  log.info({ candidateId, type, chunks: toEmbed.map(x => x.chunkType) }, 'chunks_refreshed');
}

// ── DB helpers ────────────────────────────────────────────

/** Fetch the candidate document with all text fields but NO vectors. */
async function fetchDoc(
  candidateId: string,
  type: CandidateType,
  _mode: 'full',
): Promise<IInternalCandidate | IExternalCandidate | null> {
  const Model = type === 'internal' ? InternalCandidate : ExternalCandidate;
  // Cast needed because both models share the same Mongoose model type at runtime.
  return (Model as typeof InternalCandidate).findById(candidateId).lean().exec() as Promise<IInternalCandidate | null>;
}

/** Fetch only the embedding metadata (no heavy vector arrays). */
async function fetchEmbeddingMeta(
  candidateId: string,
  type: CandidateType,
): Promise<EmbeddingMeta | null> {
  const Model = type === 'internal' ? InternalCandidate : ExternalCandidate;

  // Select embedding metadata fields only.  Vectors remain hidden
  // (select: false) so this query is cheap even for large pools.
  const doc = await (Model as typeof InternalCandidate)
    .findById(candidateId)
    .select(
      'embedding.modelId ' +
      ALL_CHUNK_TYPES.map(c => `embedding.${c}.embeddedAt`).join(' '),
    )
    .lean()
    .exec();

  return (doc?.embedding as EmbeddingMeta | undefined) ?? null;
}

/** Apply $set and optional $unset in a single updateOne call. */
async function updateEmbedding(
  candidateId: string,
  type: CandidateType,
  $set: Record<string, unknown>,
  $unset?: Record<string, ''>,
): Promise<void> {
  const Model  = type === 'internal' ? InternalCandidate : ExternalCandidate;
  // Typed explicitly so TypeScript allows dot-access ($set / $unset) without
  // the TS4111 "index signature — must use bracket notation" error.
  const update: { $set?: Record<string, unknown>; $unset?: Record<string, ''> } = {};
  if (Object.keys($set).length)                update.$set   = $set;
  if ($unset && Object.keys($unset).length)    update.$unset = $unset;
  if (!update.$set && !update.$unset)          return;

  await (Model as typeof InternalCandidate).updateOne(
    { _id: new Types.ObjectId(candidateId) },
    update,
  ).exec();
}
