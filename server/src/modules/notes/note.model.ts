import mongoose, { Schema, Document, Types } from 'mongoose';
import { NoteEntityType, NoteVisibility } from '@shadchanai/shared';

// ── Interface ─────────────────────────────────────────────

export interface INote extends Document {
  // what this note is attached to
  entityType: NoteEntityType;
  entityId: Types.ObjectId;

  // content
  body: string;

  // authorship
  authorUserId: Types.ObjectId;

  // mentions (user IDs mentioned in the note via @)
  mentions: Types.ObjectId[];

  // visibility scope
  visibility: NoteVisibility;

  // pinned to top
  pinned: boolean;

  // timestamps
  createdAt: Date;
  updatedAt: Date;
}

// ── Schema ────────────────────────────────────────────────

const noteSchema = new Schema<INote>(
  {
    entityType: {
      type: String,
      enum: Object.values(NoteEntityType),
      required: true,
    },
    entityId: { type: Schema.Types.ObjectId, required: true },

    body: { type: String, required: true, maxlength: 5000 },

    authorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    mentions: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    visibility: {
      type: String,
      enum: Object.values(NoteVisibility),
      required: true,
      default: NoteVisibility.INTERNAL,
    },

    pinned: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    collection: 'notes',
  },
);

// ── Indexes ─────────────────────────────────────────────

// Primary: all notes for a given entity, filterable by visibility
noteSchema.index({ entityType: 1, entityId: 1, visibility: 1, createdAt: -1 });

// Find notes mentioning a user
noteSchema.index({ mentions: 1 }, { sparse: true });

// Author's notes
noteSchema.index({ authorUserId: 1, createdAt: -1 });

export const Note = mongoose.model<INote>('Note', noteSchema);
