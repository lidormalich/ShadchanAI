import mongoose, { Schema, Document, Types } from 'mongoose';
import { TaskStatus, TaskPriority, TaskType } from '@shadchanai/shared';

// ── Interface ─────────────────────────────────────────────

export interface ITask extends Document {
  // type
  type: TaskType;
  title: string;
  description?: string;

  // links (optional — a task may relate to entities)
  internalCandidateId?: Types.ObjectId;
  externalCandidateId?: Types.ObjectId;
  matchSuggestionId?: Types.ObjectId;
  conversationId?: Types.ObjectId;

  // ownership
  ownerUserId: Types.ObjectId;
  assignedTo?: Types.ObjectId;

  // priority & scheduling
  priority: TaskPriority;
  dueAt?: Date;

  // status
  status: TaskStatus;
  completedAt?: Date;
  completedBy?: Types.ObjectId;
  completionNote?: string;

  // timestamps
  createdAt: Date;
  updatedAt: Date;
}

// ── Schema ────────────────────────────────────────────────

const taskSchema = new Schema<ITask>(
  {
    // ── Type ──────────────────────────────────────────────
    type: {
      type: String,
      enum: Object.values(TaskType),
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, maxlength: 2000 },

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
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
    },

    // ── Ownership ─────────────────────────────────────────
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },

    // ── Priority & scheduling ─────────────────────────────
    priority: {
      type: String,
      enum: Object.values(TaskPriority),
      required: true,
      default: TaskPriority.MEDIUM,
    },
    dueAt: { type: Date },

    // ── Status ────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(TaskStatus),
      required: true,
      default: TaskStatus.OPEN,
    },
    completedAt: { type: Date },
    completedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    completionNote: { type: String, maxlength: 1000 },
  },
  {
    timestamps: true,
    collection: 'tasks',
  },
);

// ── Indexes ─────────────────────────────────────────────

taskSchema.index({ ownerUserId: 1, status: 1 });
taskSchema.index({ assignedTo: 1, status: 1 });
taskSchema.index({ status: 1, priority: 1, dueAt: 1 });
taskSchema.index({ dueAt: 1 }, { sparse: true });
taskSchema.index({ internalCandidateId: 1 }, { sparse: true });
taskSchema.index({ matchSuggestionId: 1 }, { sparse: true });
taskSchema.index({ createdAt: -1 });

export const Task = mongoose.model<ITask>('Task', taskSchema);
