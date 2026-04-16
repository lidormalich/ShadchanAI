// ═══════════════════════════════════════════════════════════
// ChatMapping — operator-set role for a specific WhatsApp chat
// (group or private), keyed by (channelId, chatJid).
//
// Authoritative source for the ingestion gate in safe/pre-pilot
// mode: the gate reads this collection first. Conversation
// records keep an `assignedRole` only as a display cache.
// ═══════════════════════════════════════════════════════════

import mongoose, { Schema, Document, Types } from 'mongoose';

export type ChatRole = 'profiles_source' | 'match_sending' | 'ignore';
export type ChatType = 'group' | 'private';

export interface IChatMapping extends Document {
  channelId: string;
  chatJid: string;
  chatName?: string;
  chatType: ChatType;
  role: ChatRole;
  mappedBy: Types.ObjectId;
  mappedAt: Date;
  // Discovery cache — only informative:
  lastSeenAt?: Date;
  participantCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

const chatMappingSchema = new Schema<IChatMapping>(
  {
    channelId: { type: String, required: true, index: true },
    chatJid: { type: String, required: true },
    chatName: { type: String, trim: true },
    chatType: { type: String, enum: ['group', 'private'], required: true },
    role: { type: String, enum: ['profiles_source', 'match_sending', 'ignore'], required: true },
    mappedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mappedAt: { type: Date, required: true },
    lastSeenAt: { type: Date },
    participantCount: { type: Number },
  },
  { timestamps: true, collection: 'chatMappings' },
);

// A chat is mapped at most once per channel.
chatMappingSchema.index({ channelId: 1, chatJid: 1 }, { unique: true });
// Common lookup pattern in the ingestion gate.
chatMappingSchema.index({ channelId: 1, role: 1 });

export const ChatMapping = mongoose.model<IChatMapping>('ChatMapping', chatMappingSchema);
