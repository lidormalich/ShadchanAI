// ═══════════════════════════════════════════════════════════
// FailedInboundMessage — dead-letter store for inbound WhatsApp
// messages that could not be persisted (transient DB faults,
// validation errors). A background job replays 'pending' rows.
//
// Inbound persistence (message.handler) is idempotent via the
// unique externalMessageId index, so replaying a dead-lettered
// message is always safe — a duplicate just no-ops.
// ═══════════════════════════════════════════════════════════

import mongoose, { Schema, Document } from 'mongoose';

export type FailedInboundStatus = 'pending' | 'resolved' | 'parked';

export interface IFailedInboundMessage extends Document {
  /** Dedup key — the WhatsApp message id. */
  externalMessageId: string;
  providerSessionId?: string;
  channelId?: string;
  /** The NormalizedInboundMessage, stored verbatim for replay. */
  normalized: Record<string, unknown>;
  errorName?: string;
  errorMessage: string;
  /** Number of replay attempts so far (inline attempts not counted). */
  attempts: number;
  status: FailedInboundStatus;
  /** Background job replays rows where status='pending' AND nextRetryAt<=now. */
  nextRetryAt: Date;
  firstFailedAt: Date;
  lastTriedAt: Date;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const failedInboundMessageSchema = new Schema<IFailedInboundMessage>(
  {
    externalMessageId: { type: String, required: true },
    providerSessionId: { type: String },
    channelId: { type: String },
    normalized: { type: Schema.Types.Mixed, required: true },
    errorName: { type: String },
    errorMessage: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'resolved', 'parked'], default: 'pending', index: true },
    nextRetryAt: { type: Date, required: true },
    firstFailedAt: { type: Date, required: true },
    lastTriedAt: { type: Date, required: true },
    resolvedAt: { type: Date },
  },
  {
    timestamps: true,
    collection: 'failed_inbound_messages',
  },
);

// One dead-letter row per inbound message — repeated failures upsert.
failedInboundMessageSchema.index({ externalMessageId: 1 }, { unique: true });
// Replay-worker scan path.
failedInboundMessageSchema.index({ status: 1, nextRetryAt: 1 });

export const FailedInboundMessage = mongoose.model<IFailedInboundMessage>(
  'FailedInboundMessage',
  failedInboundMessageSchema,
);
