import mongoose, { Schema, Document } from 'mongoose';
import {
  ChannelRole,
  ChannelProvider,
  ChannelStatus,
  WebhookStatus,
} from '@shadchanai/shared';

// ── Interface ─────────────────────────────────────────────

export interface IChannel extends Document {
  // identity
  channelId: string;
  role: ChannelRole;
  accountDisplayName: string;

  // provider config
  /** Empty string until Baileys pairing completes; set from authenticated JID on connection. */
  phoneNumber: string;
  provider: ChannelProvider;
  /** Internal session id. For Baileys this equals channelId by default. */
  providerSessionId?: string;
  /** Optional. Unused by Baileys (no API token); reserved for future providers that need one. */
  tokenRef?: string;

  // status
  status: ChannelStatus;

  // health
  connectionHealth: 'healthy' | 'degraded' | 'down';
  webhookStatus: WebhookStatus;
  lastHealthCheckAt?: Date;

  // activity tracking
  lastConnectedAt?: Date;
  lastSyncAt?: Date;
  lastInboundAt?: Date;
  lastOutboundAt?: Date;

  // replacement chain (when an account is replaced)
  replacedByChannelId?: string;
  replacesChannelId?: string;

  // reconnect circuit / ownership
  statusReason?: string;
  lastDisconnectAt?: Date;
  ownerInstanceId?: string | null;
  ownerHeartbeatAt?: Date;

  // timestamps
  createdAt: Date;
  updatedAt: Date;
}

// ── Schema ────────────────────────────────────────────────

const channelSchema = new Schema<IChannel>(
  {
    // ── Identity ──────────────────────────────────────────
    channelId: { type: String, required: true, unique: true },
    role: {
      type: String,
      enum: Object.values(ChannelRole),
      required: true,
    },
    accountDisplayName: { type: String, required: true, trim: true },

    // ── Provider config ───────────────────────────────────
    phoneNumber: { type: String, default: '' },
    provider: {
      type: String,
      enum: Object.values(ChannelProvider),
      required: true,
      default: ChannelProvider.WHATSAPP_CLOUD,
    },
    providerSessionId: { type: String },
    tokenRef: { type: String },

    // ── Status ────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(ChannelStatus),
      required: true,
      default: ChannelStatus.ACTIVE,
    },

    // ── Health ────────────────────────────────────────────
    connectionHealth: {
      type: String,
      enum: ['healthy', 'degraded', 'down'],
      default: 'healthy',
    },
    webhookStatus: {
      type: String,
      enum: Object.values(WebhookStatus),
      default: WebhookStatus.PENDING,
    },
    lastHealthCheckAt: { type: Date },

    // ── Activity tracking ─────────────────────────────────
    lastConnectedAt: { type: Date },
    lastSyncAt: { type: Date },
    lastInboundAt: { type: Date },
    lastOutboundAt: { type: Date },

    // ── Replacement chain ─────────────────────────────────
    replacedByChannelId: { type: String },
    replacesChannelId: { type: String },

    // ── Reconnect circuit / multi-instance ownership ─────
    statusReason: { type: String },
    lastDisconnectAt: { type: Date },
    ownerInstanceId: { type: String, default: null },
    ownerHeartbeatAt: { type: Date },
  },
  {
    timestamps: true,
    collection: 'channels',
  },
);

// ── Indexes ─────────────────────────────────────────────

channelSchema.index({ role: 1, status: 1 });
channelSchema.index({ status: 1, connectionHealth: 1 });
channelSchema.index({ replacedByChannelId: 1 }, { sparse: true });

export const Channel = mongoose.model<IChannel>('Channel', channelSchema);
