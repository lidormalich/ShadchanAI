import mongoose, { Schema, Document, Types } from 'mongoose';
import {
  ChannelRole,
  MessageDirection,
  MessageContentType,
  MessageDeliveryStatus,
  MessageExtractionStatus,
  ExtractionMethod,
} from '@shadchanai/shared';

// ── Interface ─────────────────────────────────────────────

export interface IMessage extends Document {
  // conversation link
  conversationId: Types.ObjectId;

  // channel identity (denormalized for fast queries without join)
  channelId: string;
  channelRole: ChannelRole;
  accountDisplayName: string;

  // message identity
  direction: MessageDirection;
  contentType: MessageContentType;

  // content
  body?: string;
  mediaUrl?: string;
  mediaCaption?: string;
  mediaMimeType?: string;

  // provider references
  externalMessageId?: string;
  providerSessionId?: string;

  // delivery tracking (outbound only)
  deliveryStatus: MessageDeliveryStatus;
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
  failedAt?: Date;
  failureReason?: string;

  // raw provider payload (preserved for debugging/audit)
  rawPayload?: Record<string, unknown>;

  // AI classification (advisory — populated async)
  aiClassification?: {
    intent?: string;
    sentiment?: string;
    language?: string;
    classifiedAt?: Date;
  };

  // Profile-extraction pipeline (populated async on profiles_source channels).
  // `status` drives UI badges and reconciler retry. `candidateId` links
  // back to the matched/created ExternalCandidate for the "view profile"
  // action on the message bubble.
  extraction?: {
    status: MessageExtractionStatus;
    method?: ExtractionMethod;
    attemptedAt?: Date;
    completedAt?: Date;
    candidateId?: Types.ObjectId;
    confidence?: number;
    failureReason?: string;
    matchedFields?: string[];
  };

  // timestamps
  createdAt: Date;
  updatedAt: Date;
}

// ── Sub-schemas ───────────────────────────────────────────

const aiClassificationSchema = new Schema(
  {
    intent: { type: String },
    sentiment: { type: String },
    language: { type: String },
    classifiedAt: { type: Date },
  },
  { _id: false },
);

const extractionSchema = new Schema(
  {
    status: {
      type: String,
      enum: Object.values(MessageExtractionStatus),
      required: true,
    },
    method: {
      type: String,
      enum: Object.values(ExtractionMethod),
    },
    attemptedAt: { type: Date },
    completedAt: { type: Date },
    candidateId: { type: Schema.Types.ObjectId, ref: 'ExternalCandidate' },
    confidence: { type: Number, min: 0, max: 1 },
    failureReason: { type: String },
    matchedFields: [{ type: String }],
  },
  { _id: false },
);

// ── Schema ────────────────────────────────────────────────

const messageSchema = new Schema<IMessage>(
  {
    // ── Conversation link ─────────────────────────────────
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },

    // ── Channel identity (denormalized) ───────────────────
    channelId: { type: String, required: true },
    channelRole: {
      type: String,
      enum: Object.values(ChannelRole),
      required: true,
    },
    accountDisplayName: { type: String, required: true },

    // ── Direction & type ──────────────────────────────────
    direction: {
      type: String,
      enum: Object.values(MessageDirection),
      required: true,
    },
    contentType: {
      type: String,
      enum: Object.values(MessageContentType),
      required: true,
      default: MessageContentType.TEXT,
    },

    // ── Content ───────────────────────────────────────────
    body: { type: String },
    mediaUrl: { type: String },
    mediaCaption: { type: String },
    mediaMimeType: { type: String },

    // ── Provider references ───────────────────────────────
    externalMessageId: { type: String },
    providerSessionId: { type: String },

    // ── Delivery tracking ─────────────────────────────────
    deliveryStatus: {
      type: String,
      enum: Object.values(MessageDeliveryStatus),
      default: MessageDeliveryStatus.PENDING,
    },
    sentAt: { type: Date },
    deliveredAt: { type: Date },
    readAt: { type: Date },
    failedAt: { type: Date },
    failureReason: { type: String },

    // ── Raw provider payload ──────────────────────────────
    rawPayload: { type: Schema.Types.Mixed, select: false },

    // ── AI classification ─────────────────────────────────
    aiClassification: { type: aiClassificationSchema },

    // ── Profile extraction pipeline ───────────────────────
    extraction: { type: extractionSchema },
  },
  {
    timestamps: true,
    collection: 'messages',
  },
);

// ── Indexes ─────────────────────────────────────────────

// Primary: messages in a conversation, chronological
messageSchema.index({ conversationId: 1, createdAt: 1 });

// Channel-level queries
messageSchema.index({ channelId: 1, createdAt: -1 });

// Provider dedup
messageSchema.index({ externalMessageId: 1 }, { unique: true, sparse: true });

// Delivery status monitoring
messageSchema.index(
  { direction: 1, deliveryStatus: 1 },
  { partialFilterExpression: { direction: 'outbound' } },
);

// Recent messages globally
messageSchema.index({ createdAt: -1 });

// Extraction queue / reconciler: find pending-or-failed profile messages
// on profiles_source channels quickly. Sparse because only inbound
// profiles_source messages ever get an `extraction` subdoc.
messageSchema.index(
  { 'extraction.status': 1, channelRole: 1, 'extraction.attemptedAt': 1 },
  { sparse: true },
);

export const Message = mongoose.model<IMessage>('Message', messageSchema);
