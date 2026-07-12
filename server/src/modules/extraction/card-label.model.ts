// ═══════════════════════════════════════════════════════════
// CardLabel — operator-taught label→field mapping (Feature C).
//
// Lets the shidduch-card parser learn new formats without a code
// change: an operator maps a raw label they saw on a card ("כינוי")
// to a canonical field ("name"). The card-label service merges all
// rows into the parser's synonym dictionary (templates.ts) at boot
// and after every edit, so future cards in that format auto-parse
// and drop out of the review queue.
// ═══════════════════════════════════════════════════════════

import mongoose, { Schema, Document, Types } from 'mongoose';
import { FIELD_KEYS, normalizeLabel, type FieldKey } from '../../services/extraction/templates.js';

export interface ICardLabel extends Document {
  /** Raw label text as the operator typed/saw it (e.g. "כינוי"). */
  label: string;
  /** Normalized form (templates.normalizeLabel) — the dedup key. */
  labelNormalized: string;
  /** Canonical field this label feeds. */
  field: FieldKey;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const cardLabelSchema = new Schema<ICardLabel>(
  {
    label: { type: String, required: true, trim: true },
    labelNormalized: { type: String, required: true },
    field: { type: String, required: true, enum: FIELD_KEYS },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, collection: 'cardLabels' },
);

// One mapping per normalized label — teaching the same label twice updates it.
cardLabelSchema.index({ labelNormalized: 1 }, { unique: true });

// Keep the normalized form in sync with the raw label. MUST run on
// 'validate' (not 'save'): Mongoose validates BEFORE pre('save') hooks,
// so computing this in pre('save') left labelNormalized undefined at
// validation time → "Path `labelNormalized` is required" on every write.
cardLabelSchema.pre('validate', function (next) {
  this.labelNormalized = normalizeLabel(this.label);
  next();
});

export const CardLabel = mongoose.model<ICardLabel>('CardLabel', cardLabelSchema);
