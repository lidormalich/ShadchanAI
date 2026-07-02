// ═══════════════════════════════════════════════════════════
// ShadchanAI — PairScore (match-scan cache)
//
// One row per (internal, external) pair the incremental scan has
// evaluated. It is the persistent memory that makes the scan
// "smart": each row stores the hashes of both candidates at scan
// time, so a pair is only re-scored when one side actually changed.
//
// It also keeps the PREVIOUS score, so the UI can filter pairs whose
// compatibility improved or declined between scans.
//
// This is an engine-score cache — NOT the operator's decision. Manual
// decisions live on PairReview; persisted suggestions live on
// MatchSuggestion. PairScore never blocks or sends anything.
// ═══════════════════════════════════════════════════════════

import mongoose, { Schema, Document, Types } from 'mongoose';

export type PairScoreBucket = 'suitable' | 'weak' | 'blocked';
export type ScoreDirection = 'new' | 'up' | 'down' | 'same';

export interface IPairScore extends Document {
  internalCandidateId: Types.ObjectId;
  externalCandidateId: Types.ObjectId;

  // Change-detection fingerprints captured at scan time.
  internalHash: string;
  externalHash: string;

  mode: 'strict' | 'discovery';

  // Engine output (deterministic).
  eligible: boolean;
  matchScore: number;
  confidenceScore: number;
  matchType: 'safe' | 'balanced' | 'creative' | 'risky';
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  bucket: PairScoreBucket;
  blockerCodes: string[];

  // Short engine rationale surfaced in the proposal inbox: why the pair
  // fits (strengths) and where the gaps are (attention points). Capped to
  // a few items each so the cache stays lean. Populated on scan; older
  // rows are backfilled lazily on first listing.
  strengths: string[];
  attentionPoints: string[];
  // Soft age-range exception: either side's stated age preference is
  // violated beyond ±tolerance. The pair still surfaces; the UI flags it.
  ageOutOfRange: boolean;

  // Delta tracking across scans.
  previousScore?: number;
  scoreDelta: number;
  scoreDirection: ScoreDirection;

  // Set when the scan auto-created (or found) a draft suggestion.
  matchSuggestionId?: Types.ObjectId;
  autoCreated: boolean;

  scoredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const pairScoreSchema = new Schema<IPairScore>(
  {
    internalCandidateId: { type: Schema.Types.ObjectId, ref: 'InternalCandidate', required: true },
    externalCandidateId: { type: Schema.Types.ObjectId, ref: 'ExternalCandidate', required: true },

    internalHash: { type: String, required: true },
    externalHash: { type: String, required: true },

    mode: { type: String, enum: ['strict', 'discovery'], default: 'discovery' },

    eligible: { type: Boolean, required: true },
    matchScore: { type: Number, required: true, min: 0, max: 100 },
    confidenceScore: { type: Number, required: true, min: 0, max: 100 },
    matchType: { type: String, enum: ['safe', 'balanced', 'creative', 'risky'], required: true },
    riskLevel: { type: String, enum: ['none', 'low', 'medium', 'high'], default: 'none' },
    bucket: { type: String, enum: ['suitable', 'weak', 'blocked'], required: true },
    blockerCodes: { type: [String], default: [] },

    strengths: { type: [String], default: [] },
    attentionPoints: { type: [String], default: [] },
    ageOutOfRange: { type: Boolean, default: false },

    previousScore: { type: Number },
    scoreDelta: { type: Number, default: 0 },
    scoreDirection: { type: String, enum: ['new', 'up', 'down', 'same'], default: 'new' },

    matchSuggestionId: { type: Schema.Types.ObjectId, ref: 'MatchSuggestion' },
    autoCreated: { type: Boolean, default: false },

    scoredAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    collection: 'pairScores',
  },
);

// One score row per pair.
pairScoreSchema.index({ internalCandidateId: 1, externalCandidateId: 1 }, { unique: true });
// Listing / filtering by trend and score.
pairScoreSchema.index({ eligible: 1, matchScore: -1 });
pairScoreSchema.index({ scoreDirection: 1, scoredAt: -1 });

export const PairScore = mongoose.model<IPairScore>('PairScore', pairScoreSchema);

// ── Scan state (singleton) ────────────────────────────────
// Records the outcome of the most recent incremental scan so the UI
// can show "last scanned X, found Y" without recomputing. Keyed by a
// fixed singleton id so there is exactly one row.

export type ScanStatus = 'idle' | 'running' | 'done' | 'error';
export type ScanMode = 'missing' | 'incremental' | 'full';

export interface IMatchScanState extends Document {
  singleton: 'match-scan';
  // Live progress for the current/last run.
  status: ScanStatus;
  mode: ScanMode;
  progressCurrent: number;
  progressTotal: number;
  startedAt?: Date;
  lastError?: string;
  // Summary of the last COMPLETED run.
  lastScanAt?: Date;
  lastTrigger: 'manual' | 'job';
  internalsConsidered: number;
  externalsConsidered: number;
  pairsScored: number;
  pairsSkipped: number;
  draftsCreated: number;
  improved: number;
  declined: number;
  durationMs: number;
  createdAt: Date;
  updatedAt: Date;
}

const matchScanStateSchema = new Schema<IMatchScanState>(
  {
    singleton: { type: String, enum: ['match-scan'], unique: true, default: 'match-scan' },
    status: { type: String, enum: ['idle', 'running', 'done', 'error'], default: 'idle' },
    mode: { type: String, enum: ['missing', 'incremental', 'full'], default: 'incremental' },
    progressCurrent: { type: Number, default: 0 },
    progressTotal: { type: Number, default: 0 },
    startedAt: { type: Date },
    lastError: { type: String },
    lastScanAt: { type: Date },
    lastTrigger: { type: String, enum: ['manual', 'job'], default: 'manual' },
    internalsConsidered: { type: Number, default: 0 },
    externalsConsidered: { type: Number, default: 0 },
    pairsScored: { type: Number, default: 0 },
    pairsSkipped: { type: Number, default: 0 },
    draftsCreated: { type: Number, default: 0 },
    improved: { type: Number, default: 0 },
    declined: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    collection: 'matchScanState',
  },
);

export const MatchScanState = mongoose.model<IMatchScanState>('MatchScanState', matchScanStateSchema);
