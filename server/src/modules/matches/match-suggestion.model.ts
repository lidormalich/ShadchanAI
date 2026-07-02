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
    // Set when the operator has seen/handled this response. The
    // dashboard "new_response" row dismisses once acknowledgedAt
    // is >= respondedAt. Never implicitly cleared.
    acknowledgedAt: { type: Date },
    acknowledgedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false },
);

const messageDraftSchema = new Schema(
  {
    body: { type: String, default: '' },
    updatedAt: { type: Date },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    source: { type: String, enum: ['ai', 'manual'], default: 'manual' },
  },
  { _id: false },
);

const draftsSchema = new Schema(
  {
    sideA: { type: messageDraftSchema },
    sideB: { type: messageDraftSchema },
  },
  { _id: false },
);

const conversationIdsSchema = new Schema(
  {
    sideA: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    sideB: { type: Schema.Types.ObjectId, ref: 'Conversation' },
  },
  { _id: false },
);

const blockerReasonSchema = new Schema(
  {
    code: { type: String, required: true },
    severity: { type: String, required: true },
    overridable: { type: String, required: true },
    message: { type: String, required: true },
    detail: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

// Snapshot of every input the explanation depends on. Stored so we can
// (a) detect staleness by hashing it and (b) diff old↔new to tell the
// operator WHAT changed when the explanation refreshes.
const aiExplanationInputsSchema = new Schema(
  {
    internalScoringHash: { type: String },
    externalScoringHash: { type: String },
    matchScore: { type: Number },
    confidenceScore: { type: Number },
    matchType: { type: String },
    riskLevel: { type: String },
  },
  { _id: false },
);

const aiExplanationSchema = new Schema(
  {
    text: { type: String },
    strengths: [{ type: String }],
    concerns: [{ type: String }],
    nuance: { type: String },
    recommendedApproach: { type: String },
    notMatchReasons: [{ type: String }],
    generatedAt: { type: Date },
    provider: { type: String },
    model: { type: String },
    requestId: { type: Schema.Types.ObjectId, ref: 'AIRequest' },
    // Staleness key: sha256 of `inputs`. A mismatch with the current
    // inputs means the explanation is stale and must be regenerated.
    inputHash: { type: String },
    // The inputHash that was in effect BEFORE this generation — present
    // only when the explanation was refreshed (not first-generated).
    previousInputHash: { type: String },
    // The input snapshot this explanation was generated from.
    inputs: { type: aiExplanationInputsSchema },
    // Candidate updatedAt values at generation time. A candidate's data
    // only changes on a manual edit, so a newer updatedAt is our signal
    // to re-check the pair the next time this suggestion is opened.
    sourceInternalUpdatedAt: { type: Date },
    sourceExternalUpdatedAt: { type: Date },
    // Human-readable labels of what changed since the prior generation
    // (e.g. "ציון ההתאמה", "פרופיל המועמד החיצוני"). Empty on first gen.
    changedFields: [{ type: String }],
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
  // Structured blocker reasons retained on the suggestion so the UI
  // can explain a forced match. Only populated when the operator
  // forced a pair past overridable blockers via the force endpoint.
  blockers: Array<{
    code: string;
    severity: string;
    overridable: string;
    message: string;
    detail?: Record<string, unknown>;
  }>;
  // True when this suggestion was created via the force endpoint.
  forcedOverride: boolean;

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
  // In-flight claim locks (Phase 7). Prevent two concurrent
  // sendProposal calls from both racing past the "not sent yet"
  // gate and both hitting Baileys. Cleared on success/failure;
  // TTL-like via LOCK_STALE_MS in the service.
  sendInFlightSideA?: Date;
  sendInFlightSideB?: Date;

  // side responses
  sideAResponse: {
    status: string;
    respondedAt?: Date;
    declineReason?: string;
    notes?: string;
    acknowledgedAt?: Date;
    acknowledgedBy?: Types.ObjectId;
  };
  sideBResponse: {
    status: string;
    respondedAt?: Date;
    declineReason?: string;
    notes?: string;
    acknowledgedAt?: Date;
    acknowledgedBy?: Types.ObjectId;
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

  // Status-change journal — one entry per operator/auto transition, with
  // the operator's WHY. This is the learning corpus the per-candidate
  // insight agent reads to understand what the candidate responds to.
  statusHistory?: Array<{
    status: MatchSuggestionStatus;
    reason?: string;
    at: Date;
    by?: Types.ObjectId;
    auto?: boolean;
  }>;

  // Proposal message drafts — persisted per side so AI-generated
  // text survives navigation and prefills the send modal.
  drafts?: {
    sideA?: { body: string; updatedAt?: Date; updatedBy?: Types.ObjectId; source?: 'ai' | 'manual' };
    sideB?: { body: string; updatedAt?: Date; updatedBy?: Types.ObjectId; source?: 'ai' | 'manual' };
  };

  // Resolved conversations per side — populated the first time a
  // proposal is sent so the UI can navigate match ↔ conversation.
  conversationIds?: {
    sideA?: Types.ObjectId;
    sideB?: Types.ObjectId;
  };

  // AI explanation (advisory — generated after engine scoring)
  aiExplanation?: {
    text?: string;
    strengths?: string[];
    concerns?: string[];
    nuance?: string;
    recommendedApproach?: string;
    notMatchReasons?: string[];
    generatedAt?: Date;
    provider?: string;
    model?: string;
    requestId?: Types.ObjectId;
    inputHash?: string;
    previousInputHash?: string;
    inputs?: {
      internalScoringHash?: string;
      externalScoringHash?: string;
      matchScore?: number;
      confidenceScore?: number;
      matchType?: string;
      riskLevel?: string;
    };
    changedFields?: string[];
    sourceInternalUpdatedAt?: Date;
    sourceExternalUpdatedAt?: Date;
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
    blockers: { type: [blockerReasonSchema], default: [] },
    forcedOverride: { type: Boolean, default: false },

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
    sendInFlightSideA: { type: Date },
    sendInFlightSideB: { type: Date },

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

    // ── Status-change journal (learning corpus) ───────────
    statusHistory: {
      type: [
        new Schema(
          {
            status: { type: String, enum: Object.values(MatchSuggestionStatus), required: true },
            reason: { type: String, maxlength: 1000 },
            at: { type: Date, required: true },
            by: { type: Schema.Types.ObjectId, ref: 'User' },
            auto: { type: Boolean },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    // ── Proposal drafts (per side) ────────────────────────
    drafts: { type: draftsSchema },

    // ── Linked conversations (per side) ───────────────────
    conversationIds: { type: conversationIdsSchema },

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

// Dashboard "high-potential drafts"
matchSuggestionSchema.index({ status: 1, matchScore: -1, createdAt: -1, isDeferred: 1 });

// Awaiting response — side A
matchSuggestionSchema.index(
  { status: 1, sentSideAAt: 1, 'sideAResponse.status': 1 },
  { partialFilterExpression: { sentSideAAt: { $exists: true } } },
);

// Awaiting response — side B
matchSuggestionSchema.index(
  { status: 1, sentSideBAt: 1, 'sideBResponse.status': 1 },
  { partialFilterExpression: { sentSideBAt: { $exists: true } } },
);

// Deferred recheck
matchSuggestionSchema.index(
  { isDeferred: 1, deferredAt: -1, status: 1 },
  { partialFilterExpression: { isDeferred: true } },
);

export const MatchSuggestion = mongoose.model<IMatchSuggestion>(
  'MatchSuggestion',
  matchSuggestionSchema,
);
