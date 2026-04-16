import mongoose, { Schema, Document, Types } from 'mongoose';
import { ChannelRole, ConversationPurpose } from '@shadchanai/shared';

// ── Interface ─────────────────────────────────────────────

export interface IConversation extends Document {
  // channel identity
  channelId: string;
  channelRole: ChannelRole;
  accountDisplayName: string;

  // participant
  participantName?: string;
  participantPhone?: string; // only stored here for initial mapping; not used for routing
  /** Raw WhatsApp chat JID — set on create so discovery & the
   *  ChatMapping gate can correlate conversations to WhatsApp chats. */
  chatJid?: string;
  chatType?: 'group' | 'private';

  // links (optional — a conversation may be linked to entities)
  internalCandidateId?: Types.ObjectId;
  externalCandidateId?: Types.ObjectId;
  matchSuggestionId?: Types.ObjectId;

  // purpose
  purpose: ConversationPurpose;

  // Pre-pilot safe mode: per-conversation explicit role mapping.
  //   undefined        — not yet mapped → ingestion DISALLOWED
  //   'profiles_source' — inbound text is eligible for the extraction pipeline
  //   'match_sending'   — used for outbound proposals; never ingested as profile
  //   'ignore'          — fully ignored by ingestion / extraction / candidate creation
  // The channel-level role is now only a *default category* — the
  // authoritative gate for ingestion is this per-conversation field.
  assignedRole?: 'profiles_source' | 'match_sending' | 'ignore';
  assignedRoleAt?: Date;
  assignedRoleBy?: Types.ObjectId;

  // status
  isActive: boolean;
  needsAction: boolean;
  unreadCount: number;

  // provider session
  providerSessionId?: string;

  // continuity (when a WhatsApp account is replaced)
  supersedesConversationId?: Types.ObjectId;
  replacedChannelOriginId?: string;

  // timestamps
  lastMessageAt?: Date;
  lastInboundAt?: Date;
  lastOutboundAt?: Date;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ── Schema ────────────────────────────────────────────────

const conversationSchema = new Schema<IConversation>(
  {
    // ── Channel identity ──────────────────────────────────
    channelId: { type: String, required: true },
    channelRole: {
      type: String,
      enum: Object.values(ChannelRole),
      required: true,
    },
    accountDisplayName: { type: String, required: true },

    // ── Participant ───────────────────────────────────────
    participantName: { type: String, trim: true },
    participantPhone: { type: String, trim: true },
    chatJid: { type: String, trim: true, index: true, sparse: true },
    chatType: { type: String, enum: ['group', 'private'] },

    // ── Entity links ──────────────────────────────────────
    internalCandidateId: {
      type: Schema.Types.ObjectId,
      ref: 'InternalCandidate',
    },
    externalCandidateId: {
      type: Schema.Types.ObjectId,
      ref: 'ExternalCandidate',
    },
    matchSuggestionId: {
      type: Schema.Types.ObjectId,
      ref: 'MatchSuggestion',
    },

    // ── Purpose ───────────────────────────────────────────
    purpose: {
      type: String,
      enum: Object.values(ConversationPurpose),
      required: true,
      default: ConversationPurpose.GENERAL,
    },

    // ── Per-conversation role assignment (Phase: pre-pilot) ──
    assignedRole: {
      type: String,
      enum: ['profiles_source', 'match_sending', 'ignore'],
    },
    assignedRoleAt: { type: Date },
    assignedRoleBy: { type: Schema.Types.ObjectId, ref: 'User' },

    // ── Status ────────────────────────────────────────────
    isActive: { type: Boolean, default: true },
    needsAction: { type: Boolean, default: false },
    unreadCount: { type: Number, default: 0, min: 0 },

    // ── Provider session ──────────────────────────────────
    providerSessionId: { type: String },

    // ── Continuity (account replacement) ───────────────────
    supersedesConversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
    },
    replacedChannelOriginId: { type: String },

    // ── Timestamps ────────────────────────────────────────
    lastMessageAt: { type: Date },
    lastInboundAt: { type: Date },
    lastOutboundAt: { type: Date },
    archivedAt: { type: Date },
  },
  {
    timestamps: true,
    collection: 'conversations',
  },
);

// ── Indexes ─────────────────────────────────────────────

// Primary lookup: find conversations for a channel
conversationSchema.index({ channelId: 1, channelRole: 1 });
// Filter conversations by their explicit role assignment
conversationSchema.index({ assignedRole: 1 }, { sparse: true });

// Find conversations needing action
conversationSchema.index({ needsAction: 1, isActive: 1 });

// Entity link lookups
conversationSchema.index({ internalCandidateId: 1 }, { sparse: true });
conversationSchema.index({ externalCandidateId: 1 }, { sparse: true });
conversationSchema.index({ matchSuggestionId: 1 }, { sparse: true });

// Continuity chain lookups
conversationSchema.index({ supersedesConversationId: 1 }, { sparse: true });

// Recent conversations
conversationSchema.index({ lastMessageAt: -1 });
conversationSchema.index({ isActive: 1, lastMessageAt: -1 });

export const Conversation = mongoose.model<IConversation>(
  'Conversation',
  conversationSchema,
);
