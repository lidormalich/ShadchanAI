// ═══════════════════════════════════════════════════════════
// ShadchanAI — Candidate Insight (learned preference profile)
//
// One document per INTERNAL candidate. The learning agent
// (services/ai/candidate-learning.service.ts) rebuilds it from the
// candidate's full suggestion history: every status transition with
// the operator's stated reason ("לא מתאים — מרחק", "יוצאים"), decline
// reasons from both sides, and the profiles of the people they were
// matched with. The result is what the system has LEARNED about the
// candidate beyond their static profile — and it feeds both the
// operator UI and the AI explain/rank prompts so future suggestions
// are directed better.
// ═══════════════════════════════════════════════════════════

import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ICandidateInsight extends Document {
  candidateId: Types.ObjectId;

  /** Hebrew narrative: what we learned about this candidate's real preferences. */
  summary: string;
  /** Patterns the candidate responded WELL to (accepted / dating). */
  positiveSignals: string[];
  /** Recurring decline/close patterns to avoid repeating. */
  negativeSignals: string[];
  /** Actionable direction for the next suggestions ("להעדיף אזור המרכז"...). */
  guidance: string[];
  /** Model's own confidence in the learning (few data points → low). */
  confidence: number;

  /** How many suggestions (with history) the learning was based on. */
  basedOnSuggestions: number;
  /** Newest status-history timestamp folded in — drives incremental rebuilds. */
  lastActivityAt?: Date;
  /** Provider model that produced the insight. */
  learningModel?: string;

  createdAt: Date;
  updatedAt: Date;
}

const candidateInsightSchema = new Schema<ICandidateInsight>(
  {
    candidateId: {
      type: Schema.Types.ObjectId,
      ref: 'InternalCandidate',
      required: true,
      unique: true,
    },
    summary: { type: String, required: true, maxlength: 4000 },
    positiveSignals: { type: [String], default: [] },
    negativeSignals: { type: [String], default: [] },
    guidance: { type: [String], default: [] },
    confidence: { type: Number, min: 0, max: 1, default: 0 },
    basedOnSuggestions: { type: Number, default: 0 },
    lastActivityAt: { type: Date },
    learningModel: { type: String },
  },
  { timestamps: true },
);

export const CandidateInsight = mongoose.model<ICandidateInsight>(
  'CandidateInsight',
  candidateInsightSchema,
);
