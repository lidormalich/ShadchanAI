import mongoose, { Schema, Document, Types } from 'mongoose';
import { AIRequestType, AIProvider } from '@shadchanai/shared';

// ── Interface ─────────────────────────────────────────────

export interface IAIRequest extends Document {
  // request classification
  requestType: AIRequestType;

  // provider used
  provider: AIProvider;
  modelId: string;

  // dedup / cache
  inputHash: string;

  // result
  success: boolean;
  fallbackUsed: boolean;
  fallbackProvider?: string;
  retryCount: number;

  // performance
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;

  // error tracking
  errorMessage?: string;
  errorCode?: string;

  // context (optional links)
  userId?: Types.ObjectId;
  relatedEntityType?: string;
  relatedEntityId?: Types.ObjectId;

  // immutable timestamp
  createdAt: Date;
}

// ── Schema ────────────────────────────────────────────────

const aiRequestSchema = new Schema<IAIRequest>(
  {
    requestType: {
      type: String,
      enum: Object.values(AIRequestType),
      required: true,
    },

    provider: {
      type: String,
      enum: Object.values(AIProvider),
      required: true,
    },
    modelId: { type: String, required: true },

    inputHash: { type: String, required: true },

    success: { type: Boolean, required: true },
    fallbackUsed: { type: Boolean, default: false },
    fallbackProvider: { type: String },
    retryCount: { type: Number, default: 0, min: 0 },

    latencyMs: { type: Number, required: true, min: 0 },
    inputTokens: { type: Number, min: 0 },
    outputTokens: { type: Number, min: 0 },

    errorMessage: { type: String },
    errorCode: { type: String },

    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    relatedEntityType: { type: String },
    relatedEntityId: { type: Schema.Types.ObjectId },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'aiRequests',
  },
);

// AI request logs are append-only
aiRequestSchema.pre('updateOne', function () {
  throw new Error('AI request logs are immutable — updates are not allowed');
});
aiRequestSchema.pre('findOneAndUpdate', function () {
  throw new Error('AI request logs are immutable — updates are not allowed');
});

// ── Indexes ─────────────────────────────────────────────

// Cache lookup by input hash
aiRequestSchema.index({ inputHash: 1, requestType: 1, success: 1 });

// Analytics: provider performance
aiRequestSchema.index({ provider: 1, createdAt: -1 });
aiRequestSchema.index({ requestType: 1, createdAt: -1 });

// Error monitoring
aiRequestSchema.index(
  { success: 1, createdAt: -1 },
  { partialFilterExpression: { success: false } },
);

// Time-range queries
aiRequestSchema.index({ createdAt: -1 });

// User activity
aiRequestSchema.index({ userId: 1, createdAt: -1 }, { sparse: true });

// TTL — auto-expire after 90 days
aiRequestSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const AIRequest = mongoose.model<IAIRequest>('AIRequest', aiRequestSchema);
