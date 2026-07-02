import mongoose, { Schema, Document, Types } from 'mongoose';
import {
  ChannelRole,
  MessageDirection,
  MessageContentType,
  MessageDeliveryStatus,
  MessageExtractionStatus,
  ExtractionMethod,
  MessageIngestionDecision,
} from '@shadchanai/shared';

// ── Interface ─────────────────────────────────────────────

export interface IMessage extends Document {
  // conversation link
  conversationId: Types.ObjectId;

  // channel identity (denormalized for fast queries without join)
  channelId: string;
  channelRole: ChannelRole;
  accountDisplayName: string;

  // source provenance (denormalized): the chat/group and the ACTUAL sender.
  // In a group the sender differs from the group; captured for candidate
  // provenance ("who published this profile, in which group").
  chatJid?: string;
  senderName?: string;
  senderPhone?: string;

  // message identity
  direction: MessageDirection;
  contentType: MessageContentType;

  // content
  body?: string;
  mediaUrl?: string;
  mediaCaption?: string;
  mediaMimeType?: string;
  // Failed media-download attempts. The reconciler stops retrying once
  // this hits its cap — expired WhatsApp media keys ("bad decrypt") can
  // never succeed, so endless retries are pure log noise.
  mediaDownloadAttempts?: number;

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
    // Number of failed extraction attempts. The reconciler stops
    // auto-retrying once this hits the cap; manual /run still works.
    retryCount?: number;
    // The merged regex+AI profile as of the last async run. Persisted so
    // the approve path uses the enrichment the pipeline already paid for
    // instead of re-running regex-only and dropping the AI fields.
    extractedProfile?: Record<string, unknown>;
    // Why this message sits in needs_review — drives the review UI tabs
    // ('suspected_duplicate' | 'low_confidence' | 'no_identifier' | 'no_corroboration').
    reviewReason?: string;
    // Existing candidate a strong (name+age) match pointed at. Presence
    // marks a "possible duplicate person" review item: the operator
    // decides link-to-existing vs create-new. Never auto-merged.
    suspectedCandidateId?: Types.ObjectId;
    // Atomic approve claim — set once by the first approve request so a
    // double-click / second operator can't create a twin candidate.
    reviewClaimedAt?: Date;
  };

  // Ingestion routing verdict — persisted so operators can audit why a
  // message did/didn't feed extraction (the filter reason, not only logs).
  ingestion?: {
    decision: MessageIngestionDecision;
    effectiveRole?: string;
    decidedAt: Date;
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
    retryCount: { type: Number, default: 0 },
    extractedProfile: { type: Schema.Types.Mixed },
    reviewReason: { type: String },
    suspectedCandidateId: { type: Schema.Types.ObjectId, ref: 'ExternalCandidate' },
    reviewClaimedAt: { type: Date },
  },
  { _id: false },
);

const ingestionSchema = new Schema(
  {
    decision: {
      type: String,
      enum: Object.values(MessageIngestionDecision),
      required: true,
    },
    effectiveRole: { type: String },
    decidedAt: { type: Date, required: true },
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

    // ── Source provenance (denormalized) ──────────────────
    chatJid: { type: String },
    senderName: { type: String, trim: true },
    senderPhone: { type: String, trim: true },

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
    mediaDownloadAttempts: { type: Number },

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

    // ── Ingestion routing verdict ─────────────────────────
    ingestion: { type: ingestionSchema },
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

// Ingestion log: list filtered/accepted messages by decision, newest first.
messageSchema.index(
  { 'ingestion.decision': 1, 'ingestion.decidedAt': -1 },
  { sparse: true },
);

export const Message = mongoose.model<IMessage>('Message', messageSchema);
