// ═══════════════════════════════════════════════════════════
// ShadchanAI — Embedding Types
//
// Shared type definitions for the multi-chunk vector system.
// Used by: embedding.service, profile.serializer, similarity.service
//
// NOT imported by Mongoose model files — those define IEmbedding
// inline to avoid a service→model circular dependency.
// ═══════════════════════════════════════════════════════════

// ── Chunk taxonomy ────────────────────────────────────────
//
// A candidate's profile is split into 4 semantic domains before
// embedding. Each domain gets its own vector, and Atlas $rankFusion
// weights them differently when searching.
//
// Weights must sum to 1.0 — see CHUNK_WEIGHTS below.

export type ChunkType = 'religious' | 'expectations' | 'personality' | 'background';

export const ALL_CHUNK_TYPES: readonly ChunkType[] = [
  'religious',
  'expectations',
  'personality',
  'background',
] as const;

// ── $rankFusion weights ───────────────────────────────────
//
// These weights are applied inside the Atlas $rankFusion aggregation
// stage — NOT computed in Node.js. They encode the relative
// importance of each semantic domain for matchmaking:
//
//   religious (0.40) — Most important. In the Israeli religious dating
//     market, alignment on sector/lifestyle is the primary driver of
//     compatibility and is the leading reason matches are declined.
//
//   expectations (0.30) — What someone is looking for in a partner.
//     Misaligned expectations cause most post-meeting rejections.
//
//   personality (0.20) — Character and self-description. Important but
//     harder to assess from text alone; gets lower weight as a result.
//
//   background (0.10) — Age, location, life-stage. These are already
//     partially enforced by the Atlas pre-filter (hard constraints),
//     so adding heavy vector weight here would double-count them.

export const CHUNK_WEIGHTS: Readonly<Record<ChunkType, number>> = {
  religious:    0.40,
  expectations: 0.30,
  personality:  0.20,
  background:   0.10,
} as const;

// ── Serializer output ─────────────────────────────────────
//
// null means "this chunk has no meaningful content" — the embedding
// service will skip it and its sub-pipeline will be omitted from
// the $rankFusion query.  An empty string is never produced.

export interface ChunkTexts {
  religious:    string | null;
  expectations: string | null;
  personality:  string | null;
  background:   string | null;
}

// ── Loaded vectors for similarity search ──────────────────
//
// undefined = chunk not yet embedded or not available.
// The similarity service omits sub-pipelines for undefined chunks
// and re-normalises weights across the remaining ones.

export interface CandidateChunks {
  religious?:    number[];
  expectations?: number[];
  personality?:  number[];
  background?:   number[];
}

// ── Model configuration ───────────────────────────────────

export interface EmbeddingModelConfig {
  /** HuggingFace model ID, e.g. 'BAAI/bge-m3' */
  modelId: string;
  /** Provider slug stored in the DB, e.g. 'huggingface' */
  provider: string;
  /** Output vector dimensionality — must match the Atlas index */
  dimensions: number;
}

// ── Fields that invalidate each chunk when changed ────────
//
// Used by controllers to know which chunks to mark stale after a
// PATCH.  Add new fields here as the schema evolves.

export const CHUNK_INVALIDATION_MAP: Readonly<Record<ChunkType, string[]>> = {
  religious: [
    'sectorGroup', 'subSector', 'lifestyleTone', 'religiousStyle',
  ],
  expectations: [
    'whatSeeking', 'softPreferences', 'hardConstraints',
    'openness', 'agePreferences', 'locationPreferences', 'lifeGoals',
  ],
  personality: [
    'about', 'aiEnrichment', 'characterTraits', 'characterNotes', 'additionalInfo',
  ],
  background: [
    'city', 'age', 'dateOfBirth', 'personalStatus', 'numberOfChildren',
    'lifeStage', 'studyWorkDirection', 'currentOccupation',
    'educationLevel', 'armyService',
  ],
} as const;
