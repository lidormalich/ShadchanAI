// ═══════════════════════════════════════════════════════════
// PairReview — operator-level memory for an internal↔external
// candidate pair.
//
// Sits ABOVE the deterministic engine: it never overrides the
// engine result, but it lets the operator persist a manual
// judgment + reason + outcome, and makes that judgment visible
// the next time the same pair is evaluated.
//
// Each (internalCandidateId, externalCandidateId) pair has at
// most one row. The history[] array preserves prior decisions
// so the operator can see how their judgment evolved.
// ═══════════════════════════════════════════════════════════

import mongoose, { Schema, type Document, Types } from 'mongoose';

export type PairReviewStatus =
  | 'suitable'
  | 'not_suitable'
  | 'review_later'
  | 'forced'
  | 'rejected_after_contact';

export interface IPairReviewHistoryEntry {
  status: PairReviewStatus;
  reason?: string;
  reviewedBy: Types.ObjectId;
  reviewedAt: Date;
}

export interface IPairReviewAIExplanation {
  text?: string;
  strengths?: string[];
  concerns?: string[];
  // Specific reasons this pair is NOT a good match ("למה לא מתאים").
  // Persisted so the operator sees the documented reasons next time
  // without re-running AI. Mirrors the reasons added to the bank.
  notMatchReasons?: string[];
  generatedAt?: Date;
  provider?: string;
  model?: string;
}

export interface IPairReview extends Document {
  internalCandidateId: Types.ObjectId;
  externalCandidateId: Types.ObjectId;

  manualStatus: PairReviewStatus;
  operatorReason?: string;
  // Filled when manualStatus is 'rejected_after_contact' — captures
  // the post-contact outcome (declined by side, family mismatch, etc.).
  outcomeReason?: string;
  // Optional link to the suggestion this review was tied to.
  matchSuggestionId?: Types.ObjectId;

  reviewedBy: Types.ObjectId;
  reviewedAt: Date;

  // Append-only journal of every prior decision on this pair.
  history: IPairReviewHistoryEntry[];

  // Cached AI commentary. Strictly advisory: never used for scoring
  // and never overrides deterministic blockers. Re-generated on
  // demand.
  aiExplanation?: IPairReviewAIExplanation;

  createdAt: Date;
  updatedAt: Date;
}

const historySchema = new Schema<IPairReviewHistoryEntry>(
  {
    status: {
      type: String,
      enum: ['suitable', 'not_suitable', 'review_later', 'forced', 'rejected_after_contact'],
      required: true,
    },
    reason: { type: String, trim: true, maxlength: 1000 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedAt: { type: Date, required: true },
  },
  { _id: false },
);

const aiExplanationSchema = new Schema<IPairReviewAIExplanation>(
  {
    text: { type: String, trim: true },
    strengths: [{ type: String, trim: true }],
    concerns: [{ type: String, trim: true }],
    notMatchReasons: [{ type: String, trim: true }],
    generatedAt: { type: Date },
    provider: { type: String, trim: true },
    model: { type: String, trim: true },
  },
  { _id: false },
);

const pairReviewSchema = new Schema<IPairReview>(
  {
    internalCandidateId: {
      type: Schema.Types.ObjectId,
      ref: 'InternalCandidate',
      required: true,
    },
    externalCandidateId: {
      type: Schema.Types.ObjectId,
      ref: 'ExternalCandidate',
      required: true,
    },
    manualStatus: {
      type: String,
      enum: ['suitable', 'not_suitable', 'review_later', 'forced', 'rejected_after_contact'],
      required: true,
    },
    operatorReason: { type: String, trim: true, maxlength: 1000 },
    outcomeReason: { type: String, trim: true, maxlength: 1000 },
    matchSuggestionId: { type: Schema.Types.ObjectId, ref: 'MatchSuggestion' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedAt: { type: Date, required: true },
    history: { type: [historySchema], default: [] },
    aiExplanation: { type: aiExplanationSchema },
  },
  { timestamps: true, collection: 'pairReviews' },
);

// Each pair has at most one review row; history preserves prior decisions.
pairReviewSchema.index(
  { internalCandidateId: 1, externalCandidateId: 1 },
  { unique: true },
);
// Common board lookup pattern.
pairReviewSchema.index({ internalCandidateId: 1, manualStatus: 1 });

export const PairReview = mongoose.model<IPairReview>('PairReview', pairReviewSchema);
