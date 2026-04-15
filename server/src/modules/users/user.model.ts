// ═══════════════════════════════════════════════════════════
// ShadchanAI — User Model
//
// Minimal user model for admin authentication. Roles follow
// the permission scaffold already used in the permissions
// middleware: admin / shadchan / reviewer / viewer.
// ═══════════════════════════════════════════════════════════

import mongoose, { Schema, Document } from 'mongoose';

export type UserRole = 'admin' | 'shadchan' | 'reviewer' | 'viewer';

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  name: string;
  roles: UserRole[];
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    /** bcrypt hash — never returned via API */
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    roles: {
      type: [String],
      enum: ['admin', 'shadchan', 'reviewer', 'viewer'],
      default: ['shadchan'],
    },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
  },
  {
    timestamps: true,
    collection: 'users',
  },
);

// Email is the login identifier — unique across the system
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ isActive: 1, roles: 1 });

// Strip passwordHash from any accidental toJSON / toObject
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const r = ret as unknown as Record<string, unknown>;
    delete r['passwordHash'];
    return r;
  },
});

export const User = mongoose.model<IUser>('User', userSchema);
