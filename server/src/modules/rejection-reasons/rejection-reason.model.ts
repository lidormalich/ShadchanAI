// ═══════════════════════════════════════════════════════════
// RejectionReason — a growing bank ("מאגר סיבות") of the reasons
// a pair turned out NOT to be a good match.
//
// Two kinds of entries live here:
//   - deterministic: seeded from engine blockers / low-scoring
//     dimensions. Keyed by a STABLE `code` so the same engine
//     reason is reused verbatim every time it fires.
//   - ai / operator: free-text reasons the AI (or a Shadchan)
//     produced. Deduped fuzzily against existing entries in the
//     same category so the bank stays compact instead of
//     accumulating near-duplicates.
//
// The bank is advisory metadata only — it never feeds scoring.
// Its value is reuse: when the engine/AI hits a reason we've
// already seen, we increment usage instead of inventing a new
// phrasing; when it's genuinely new, we add it.
// ═══════════════════════════════════════════════════════════

import mongoose, { Schema, type Document, Types } from 'mongoose';

export type RejectionReasonSource = 'deterministic' | 'ai' | 'operator';

export interface IRejectionReason extends Document {
  // Stable slug. Deterministic reasons reuse a fixed code (e.g.
  // 'blocker:active_pair_duplicate'); AI reasons get a hash-derived code.
  code: string;
  // Coarse bucket used both for display grouping and to scope fuzzy
  // dedup (we only merge reasons within the same category).
  category: string;
  // Canonical human-readable text (Hebrew).
  text: string;
  // Normalized form (lowercased, niqqud/punctuation stripped) — the
  // key fuzzy matching compares against.
  normalizedText: string;
  source: RejectionReasonSource;
  // How many times this reason has been surfaced across all pairs.
  usageCount: number;
  lastUsedAt: Date;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const rejectionReasonSchema = new Schema<IRejectionReason>(
  {
    code: { type: String, required: true, unique: true },
    category: { type: String, required: true },
    text: { type: String, required: true, trim: true, maxlength: 500 },
    normalizedText: { type: String, required: true },
    source: {
      type: String,
      enum: ['deterministic', 'ai', 'operator'],
      required: true,
    },
    usageCount: { type: Number, default: 1, min: 0 },
    lastUsedAt: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, collection: 'rejectionReasons' },
);

// Fuzzy-dedup lookup is scoped per category.
rejectionReasonSchema.index({ category: 1 });
// Browse / leaderboard: most-used reasons first.
rejectionReasonSchema.index({ usageCount: -1 });

export const RejectionReason = mongoose.model<IRejectionReason>(
  'RejectionReason',
  rejectionReasonSchema,
);
