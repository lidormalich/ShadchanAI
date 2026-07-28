// ═══════════════════════════════════════════════════════════
// DiscoverySession — "היכרות חכמה" public swipe link.
//
// An operator mints an expiring public token for an INTERNAL
// candidate. The candidate opens /meet/:token (no login), answers
// a trait wizard, then swipes through batches of ANONYMIZED real
// external candidates. Every verdict (like/reject + reason) is a
// learning signal — likes never create a MatchSuggestion.
//
// Design invariants:
//   - Soft expiry ONLY (status + expiresAt) — no Mongo TTL index.
//     The verdicts are a learning corpus; access expires, data stays.
//   - cardId is an opaque random id; the real externalCandidateId
//     never crosses the public boundary (anti-enumeration).
//   - One session in ['pending_traits','active'] per internal
//     candidate — creating a new one revokes the previous.
// ═══════════════════════════════════════════════════════════

import mongoose, { Schema, type Document, Types } from 'mongoose';

export type DiscoverySessionStatus =
  | 'pending_traits'  // link opened-or-not; wizard not yet submitted
  | 'active'          // traits submitted, swiping
  | 'completed'       // candidate pressed finish (or exhausted the deck)
  | 'revoked'         // operator killed the link
  | 'expired';        // expiresAt passed (flipped lazily / by the hourly job)

export type DiscoveryVerdict = 'like' | 'reject' | 'skip';

export interface IDiscoveryCard {
  cardId: string;
  externalCandidateId: Types.ObjectId;
  batchIndex: number;
  servedAt: Date;
  // Deterministic engine matchScore at serve time (0-100).
  engineScore: number;
  // Blended preference-similarity signal used for ordering (0-1), if any.
  prefSim?: number;
  // Final blended rank score the card was ordered by.
  finalRank?: number;
  hasPhoto: boolean;
  verdict?: DiscoveryVerdict;
  reasonChips?: string[];
  reasonText?: string;
  verdictAt?: Date;
}

export interface IDiscoveryAISummary {
  // Batch index this summary was computed AFTER (its verdicts included).
  round: number;
  summary: string;
  positiveSignals: string[];
  negativeSignals: string[];
  // Hard filters for the next batches. Server-side allow-listed —
  // see discovery-ranking.service (unknown fields are dropped).
  avoidFilters: Array<{ field: string; value: string }>;
  confidence: number;
  model?: string;
  at: Date;
}

export type DiscoveryWizardQuestionType = 'single' | 'multi' | 'range';

export interface IDiscoveryWizardQuestion {
  id: string;
  question: string; // Hebrew
  type: DiscoveryWizardQuestionType;
  // Which traitPicks slot the answer maps onto. Allow-listed in
  // discovery-vocab.ts — the AI may pick phrasing, never fields.
  mapsTo: string;
  options: Array<{ value: string; label: string }>;
}

export interface IDiscoveryWizard {
  source: 'ai' | 'static';
  questions: IDiscoveryWizardQuestion[];
  generatedAt: Date;
  model?: string;
}

export interface IDiscoveryTraitPicks {
  ageMin?: number;
  ageMax?: number;
  regions?: string[];
  openness?: {
    openToOtherSectors?: boolean;
    openToDivorced?: boolean;
    openToWithChildren?: boolean;
    openToLongDistance?: boolean;
  };
  softPreferences?: Array<{ field: string; value: string; importance: string }>;
  freeText?: string;
}

export interface IDiscoverySession extends Document {
  token: string;
  internalCandidateId: Types.ObjectId;
  status: DiscoverySessionStatus;
  expiresAt: Date;
  wizard?: IDiscoveryWizard;
  traitPicks?: IDiscoveryTraitPicks;
  cards: IDiscoveryCard[];
  aiSummaries: IDiscoveryAISummary[];
  // Index of the batch currently being generated/served. 0 = none yet.
  currentBatchIndex: number;
  counters: {
    served: number;
    liked: number;
    rejected: number;
    skipped: number;
    aiCalls: number;
  };
  createdBy: Types.ObjectId;
  finishedAt?: Date;
  // Set once foldSessionIntoLearning ran — idempotency guard.
  learningFoldedAt?: Date;
  // Operator opened the session detail — clears "ממתין לסקירה".
  operatorViewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const discoveryCardSchema = new Schema<IDiscoveryCard>(
  {
    cardId: { type: String, required: true },
    externalCandidateId: { type: Schema.Types.ObjectId, ref: 'ExternalCandidate', required: true },
    batchIndex: { type: Number, required: true },
    servedAt: { type: Date, required: true },
    engineScore: { type: Number, required: true, min: 0, max: 100 },
    prefSim: { type: Number, min: 0, max: 1 },
    finalRank: { type: Number },
    hasPhoto: { type: Boolean, default: false },
    verdict: { type: String, enum: ['like', 'reject', 'skip'] },
    reasonChips: { type: [String], default: undefined },
    reasonText: { type: String, maxlength: 300, trim: true },
    verdictAt: { type: Date },
  },
  { _id: false },
);

const discoveryAISummarySchema = new Schema<IDiscoveryAISummary>(
  {
    round: { type: Number, required: true },
    summary: { type: String, required: true, maxlength: 2000 },
    positiveSignals: { type: [String], default: [] },
    negativeSignals: { type: [String], default: [] },
    avoidFilters: {
      type: [new Schema({ field: String, value: String }, { _id: false })],
      default: [],
    },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    model: { type: String },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const discoveryWizardSchema = new Schema<IDiscoveryWizard>(
  {
    source: { type: String, enum: ['ai', 'static'], required: true },
    questions: {
      type: [
        new Schema(
          {
            id: { type: String, required: true },
            question: { type: String, required: true, maxlength: 300 },
            type: { type: String, enum: ['single', 'multi', 'range'], required: true },
            mapsTo: { type: String, required: true },
            options: {
              type: [new Schema({ value: String, label: String }, { _id: false })],
              default: [],
            },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    generatedAt: { type: Date, required: true },
    model: { type: String },
  },
  { _id: false },
);

const discoverySessionSchema = new Schema<IDiscoverySession>(
  {
    token: { type: String, required: true, unique: true },
    internalCandidateId: {
      type: Schema.Types.ObjectId,
      ref: 'InternalCandidate',
      required: true,
    },
    status: {
      type: String,
      enum: ['pending_traits', 'active', 'completed', 'revoked', 'expired'],
      default: 'pending_traits',
    },
    expiresAt: { type: Date, required: true },
    wizard: { type: discoveryWizardSchema },
    traitPicks: {
      type: new Schema(
        {
          ageMin: { type: Number, min: 16, max: 120 },
          ageMax: { type: Number, min: 16, max: 120 },
          regions: { type: [String], default: undefined },
          openness: {
            type: new Schema(
              {
                openToOtherSectors: Boolean,
                openToDivorced: Boolean,
                openToWithChildren: Boolean,
                openToLongDistance: Boolean,
              },
              { _id: false },
            ),
          },
          softPreferences: {
            type: [
              new Schema(
                { field: String, value: String, importance: String },
                { _id: false },
              ),
            ],
            default: undefined,
          },
          freeText: { type: String, maxlength: 300, trim: true },
        },
        { _id: false },
      ),
    },
    cards: { type: [discoveryCardSchema], default: [] },
    aiSummaries: { type: [discoveryAISummarySchema], default: [] },
    currentBatchIndex: { type: Number, default: 0 },
    counters: {
      served: { type: Number, default: 0 },
      liked: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      aiCalls: { type: Number, default: 0 },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    finishedAt: { type: Date },
    learningFoldedAt: { type: Date },
    operatorViewedAt: { type: Date },
  },
  { timestamps: true, collection: 'discoverySessions' },
);

// Operator panel: sessions per candidate, newest first.
discoverySessionSchema.index({ internalCandidateId: 1, createdAt: -1 });
// Hourly expiry job scan. Deliberately NOT a TTL index — see header.
discoverySessionSchema.index({ status: 1, expiresAt: 1 });

export const DiscoverySession = mongoose.model<IDiscoverySession>(
  'DiscoverySession',
  discoverySessionSchema,
);
