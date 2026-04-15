import mongoose, { Schema, Document, Types } from 'mongoose';
import { AuditActionType, AuditEntityType } from '@shadchanai/shared';

// ── Interface ─────────────────────────────────────────────

export interface IAuditLog extends Document {
  // what was acted on
  entityType: AuditEntityType;
  entityId: Types.ObjectId;

  // what happened
  actionType: AuditActionType;

  // who did it
  performedBy: Types.ObjectId;

  // before/after snapshots (for update/delete actions)
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;

  // additional context
  metadata?: Record<string, unknown>;

  // IP/user-agent for security audit
  ipAddress?: string;
  userAgent?: string;

  // immutable timestamp
  createdAt: Date;
}

// ── Schema ────────────────────────────────────────────────

const auditLogSchema = new Schema<IAuditLog>(
  {
    entityType: {
      type: String,
      enum: Object.values(AuditEntityType),
      required: true,
    },
    entityId: { type: Schema.Types.ObjectId, required: true },

    actionType: {
      type: String,
      enum: Object.values(AuditActionType),
      required: true,
    },

    performedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },

    metadata: { type: Schema.Types.Mixed },

    ipAddress: { type: String },
    userAgent: { type: String },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'auditLogs',
  },
);

// Audit logs are append-only — no updates allowed
auditLogSchema.pre('updateOne', function () {
  throw new Error('Audit logs are immutable — updates are not allowed');
});
auditLogSchema.pre('findOneAndUpdate', function () {
  throw new Error('Audit logs are immutable — updates are not allowed');
});

// ── Indexes ─────────────────────────────────────────────

// Primary: all actions on an entity
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

// Who did what
auditLogSchema.index({ performedBy: 1, createdAt: -1 });

// Action type queries (e.g., "show all match_sent events")
auditLogSchema.index({ actionType: 1, createdAt: -1 });

// Time-range queries
auditLogSchema.index({ createdAt: -1 });

// NOTE: No TTL index. Retention policy should be configured at the
// application or infrastructure level once compliance requirements are confirmed.
// To add TTL later: auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: N });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
