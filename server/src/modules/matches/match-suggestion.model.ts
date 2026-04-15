import mongoose, { Schema, Document, Types } from 'mongoose';
import {
  MatchSuggestionStatus,
  MatchType,
  RiskLevel,
  SourceMode,
  RecommendedAction,
  SendStrategy,
  ScoringDimension,
} from '@shadchanai/shared';

// ── Sub-schemas ───────────────────────────────────────────

const scoreDimensionSchema = new Schema(
  {
    dimension: {
      type: String,
      enum: Object.values(ScoringDimension),
      required: true,
    },
    score: { type: Number, required: true, min: 0, max: 100 },
    weight: { type: Number, required: true, min: 0, max: 1 },
    weightedScore: { type: Number, required: true },
    detail: { type: String },
  },
  { _id: false },
);

const penaltiesSchema = new Schema(
  {
    historyPenalty: { type: Number, default: 0 },
    stalePenalty: { type: Number, default: 0 },
    timingPenalty: { type: Number, default: 0 },
    loadPenalty: { type: Number, default: 0 },
    totalPenalty: { type: Number, default: 0 },
  },
  { _id: false },
);

const sideResponseSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'considering', 'no_response'],
      required: true,
      default: 'pending',
    },
    respondedAt: { type: Date },
    declineReason: { type: String },
    notes: { type: String },
  },
  { _id: false },
);

const aiExplanationSchema = new Schema(
  {
    text: { type: String },
    strengths: [{ type: String }],
    concerns: [{ type: String }],
    generatedAt: { type: Date },
    provider: { type: String },
    model: { type: String },
    requestId: { type: Schema.Types.ObjectId, ref: 'AIRequest' },
  },
  { _id: false },
);

// ── Interface ─────────────────────────────────────────────

export interface IMatchSuggestion extends Document {
  // core pairing
  internalCandidateId: Types.ObjectId;
  externalCandidateId: Types.ObjectId;

  // eligibility
  eligible: boolean;

  // status lifecycle
  status: MatchSuggestionStatus;

  // engine scores (deterministic — source of truth)
  matchScore: number;
  confidenceScore: number;
  matchType: MatchType;
  riskLevel: RiskLevel;

  // score details
  scoreBreakdown: Array<{
    dimension: string;
    score: number;
    weight: number;
    weightedScore: number;
    detail?: string;
  }>;

  // engine analysis
  hardBlockers: string[];
  strengths: string[];
  attentionPoints: string[];

  // override
  overrideReasons: string[];
  flexibilityOverrideApplied: boolean;

  // strategy
  recommendedAction: RecommendedAction;
  sendStrategy: SendStrategy;
  sourceMode: SourceMode;

  // penalties
  penalties: {
    historyPenalty: number;
    stalePenalty: number;
    timingPenalty: number;
    loadPenalty: number;
    totalPenalty: number;
  };

  // semantic similarity
  semanticSimilarityScore?: number;

  // ownership
  ownerUserId: Types.ObjectId;
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;

  // send tracking
  sentSideAAt?: Date;
  sentSideBAt?: Date;

  // side responses
  sideAResponse: {
    status: string;
    respondedAt?: Date;
    declineReason?: string;
    notes?: string;
  };
  sideBResponse: {
    status: string;
    respondedAt?: Date;
    declineReason?: string;
    notes?: string;
  };

  // deferred queue
  isDeferred: boolean;
  deferredAt?: Date;
  deferredReason?: string;
  reopenedFromDeferredAt?: Date;

  // dating
  datingStartedAt?: Date;

  // closure
  closedAt?: Date;
  closeReason?: string;

  // AI explanation (advisory — generated after engine scoring)
  aiExplanation?: {
    text?: string;
    strengths?: string[];
    concerns?: string[];
    generatedAt?: Date;
    provider?: string;
    model?: string;
    requestId?: Types.ObjectId;
  };

  // timestamps
  createdAt: Date;
  updatedAt: Date;
}

// ── Schema ────────────────────────────────────────────────

const matchSuggestionSchema = new Schema<IMatchSuggestion>(
  {
    // ── Core pairing ──────────────────────────────────────
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

    // ── Eligibility ───────────────────────────────────────
    eligible: { type: Boolean, required: true, default: true },

    // ── Status ────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(MatchSuggestionStatus),
      required: true,
      default: MatchSuggestionStatus.DRAFT,
    },

    // ── Engine scores (deterministic) ─────────────────────
    matchScore: { type: Number, required: true, min: 0, max: 100 },
    confidenceScore: { type: Number, required: true, min: 0, max: 100 },
    matchType: {
      type: String,
      enum: Object.values(MatchType),
      required: true,
    },
    riskLevel: {
      type: String,
      enum: Object.values(RiskLevel),
      required: true,
      default: RiskLevel.NONE,
    },

    // ── Score breakdown ───────────────────────────────────
    scoreBreakdown: { type: [scoreDimensionSchema], default: [] },

    // ── Engine analysis ───────────────────────────────────
    hardBlockers: { type: [String], default: [] },
    strengths: { type: [String], default: [] },
    attentionPoints: { type: [String], default: [] },

    // ── Override ──────────────────────────────────────────
    overrideReasons: { type: [String], default: [] },
    flexibilityOverrideApplied: { type: Boolean, default: false },

    // ── Strategy ──────────────────────────────────────────
    recommendedAction: {
      type: String,
      enum: Object.values(RecommendedAction),
      default: RecommendedAction.REVIEW_FIRST,
    },
    sendStrategy: {
      type: String,
      enum: Object.values(SendStrategy),
      default: SendStrategy.SIDE_A_FIRST,
    },
    sourceMode: {
      type: String,
      enum: Object.values(SourceMode),
      required: true,
    },

    // ── Penalties ─────────────────────────────────────────
    penalties: {
      type: penaltiesSchema,
      default: () => ({}),
    },

    // ── Semantic similarity ───────────────────────────────
    semanticSimilarityScore: { type: Number, min: 0, max: 1 },

    // ── Ownership ─────────────────────────────────────────
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },

    // ── Send tracking ─────────────────────────────────────
    sentSideAAt: { type: Date },
    sentSideBAt: { type: Date },

    // ── Side responses ────────────────────────────────────
    sideAResponse: {
      type: sideResponseSchema,
      default: () => ({ status: 'pending' }),
    },
    sideBResponse: {
      type: sideResponseSchema,
      default: () => ({ status: 'pending' }),
    },

    // ── Deferred queue ─────────────────────────────────────
    isDeferred: { type: Boolean, default: false },
    deferredAt: { type: Date },
    deferredReason: { type: String },
    reopenedFromDeferredAt: { type: Date },

    // ── Dating ────────────────────────────────────────────
    datingStartedAt: { type: Date },

    // ── Closure ───────────────────────────────────────────
    closedAt: { type: Date },
    closeReason: { type: String },

    // ── AI explanation (advisory) ─────────────────────────
    aiExplanation: { type: aiExplanationSchema },
  },
  {
    timestamps: true,
    collection: 'matchSuggestions',
  },
);

// ── Indexes ─────────────────────────────────────────────

// Primary lookup patterns
matchSuggestionSchema.index({ internalCandidateId: 1, status: 1 });
matchSuggestionSchema.index({ externalCandidateId: 1, status: 1 });
matchSuggestionSchema.index({ ownerUserId: 1, status: 1 });

// Prevent duplicate active suggestions for same pair
matchSuggestionSchema.index(
  { internalCandidateId: 1, externalCandidateId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $nin: ['closed', 'expired'] },
    },
  },
);

// Score-based queries (leaderboard, top matches)
matchSuggestionSchema.index({ matchScore: -1 });
matchSuggestionSchema.index({ matchType: 1, status: 1 });

// Deferred queue
matchSuggestionSchema.index(
  { isDeferred: 1, deferredAt: -1 },
  { partialFilterExpression: { isDeferred: true } },
);

// Temporal queries
matchSuggestionSchema.index({ createdAt: -1 });
matchSuggestionSchema.index({ datingStartedAt: 1 }, { sparse: true });

export const MatchSuggestion = mongoose.model<IMatchSuggestion>(
  'MatchSuggestion',
  matchSuggestionSchema,
);
