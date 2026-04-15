// ═══════════════════════════════════════════════════════════
// ShadchanAI — Auth Service
//
// Responsibilities:
//   - Hash/verify passwords (bcrypt, cost 12)
//   - Issue JWTs
//   - Register / login / change-password / bootstrap-admin
//   - Audit every auth-relevant action
//
// Bootstrap note: the very first user can be created via
// bootstrapAdmin() when there are zero users in the system.
// After that, admin users create more users. Self-registration
// is NOT enabled by default.
// ═══════════════════════════════════════════════════════════

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { AuditActionType, AuditEntityType } from '@shadchanai/shared';
import { User, type IUser, type UserRole } from '../../models/index.js';
import { env } from '../../config/env.js';
import { audit } from '../../services/audit.service.js';
import { ForbiddenError, UnauthorizedError, ConflictError, NotFoundError } from '../../utils/errors.js';
import type { LoginInput, RegisterInput } from './auth.validator.js';

const BCRYPT_COST = 12;

export interface AuthTokenPayload {
  sub: string;
  email: string;
  roles: UserRole[];
}

export interface AuthResult {
  token: string;
  expiresIn: string;
  user: {
    id: string;
    email: string;
    name: string;
    roles: UserRole[];
  };
}

// ── Password helpers ─────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ── Token issuance / verification ────────────────────────

export function issueToken(user: IUser): AuthResult {
  const payload: AuthTokenPayload = {
    sub: String(user._id),
    email: user.email,
    roles: user.roles as UserRole[],
  };
  const signOpts = { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions;
  const token = jwt.sign(payload, env.JWT_SECRET, signOpts);
  return {
    token,
    expiresIn: env.JWT_EXPIRES_IN,
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      roles: user.roles as UserRole[],
    },
  };
}

export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
  } catch {
    return null;
  }
}

// ── Login ────────────────────────────────────────────────

export async function login(input: LoginInput, meta: { ip?: string; userAgent?: string } = {}): Promise<AuthResult> {
  const user = await User.findOne({ email: input.email.toLowerCase() })
    .select('+passwordHash')
    .exec();

  if (!user || !user.isActive) {
    // Same error message for "not found" and "wrong password" — no user enumeration
    throw new UnauthorizedError('Invalid credentials');
  }

  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    throw new UnauthorizedError('Invalid credentials');
  }

  user.lastLoginAt = new Date();
  await user.save();

  await audit({
    entityType: AuditEntityType.USER,
    entityId: String(user._id),
    actionType: AuditActionType.LOGIN,
    performedBy: String(user._id),
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });

  return issueToken(user);
}

// ── Register (admin-only) ────────────────────────────────

export async function registerUser(
  input: RegisterInput,
  performedBy: string,
): Promise<IUser> {
  const existing = await User.findOne({ email: input.email.toLowerCase() }).exec();
  if (existing) throw new ConflictError('Email is already registered');

  const user = await User.create({
    email: input.email.toLowerCase(),
    passwordHash: await hashPassword(input.password),
    name: input.name,
    roles: input.roles ?? ['shadchan'],
    isActive: true,
  });

  await audit({
    entityType: AuditEntityType.USER,
    entityId: String(user._id),
    actionType: AuditActionType.CREATE,
    performedBy,
    after: { email: user.email, name: user.name, roles: user.roles, isActive: user.isActive },
  });

  return user;
}

// ── Bootstrap first admin if the users collection is empty ──

export async function bootstrapAdminIfNeeded(
  input: RegisterInput,
): Promise<{ bootstrapped: boolean; user?: IUser }> {
  const count = await User.estimatedDocumentCount();
  if (count > 0) return { bootstrapped: false };

  const user = await User.create({
    email: input.email.toLowerCase(),
    passwordHash: await hashPassword(input.password),
    name: input.name,
    roles: ['admin'],
    isActive: true,
  });
  console.log('[auth] Bootstrapped first admin:', user.email);

  await audit({
    entityType: AuditEntityType.USER,
    entityId: String(user._id),
    actionType: AuditActionType.CREATE,
    performedBy: String(user._id),
    metadata: { bootstrap: true },
  });

  return { bootstrapped: true, user };
}

// ── Change password ──────────────────────────────────────

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (!Types.ObjectId.isValid(userId)) throw new NotFoundError('User', userId);
  const user = await User.findById(userId).select('+passwordHash').exec();
  if (!user) throw new NotFoundError('User', userId);

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) throw new ForbiddenError('Current password is incorrect');

  user.passwordHash = await hashPassword(newPassword);
  await user.save();

  await audit({
    entityType: AuditEntityType.USER,
    entityId: userId,
    actionType: AuditActionType.UPDATE,
    performedBy: userId,
    metadata: { scope: 'change_password' },
  });
}

// ── Get current user (for /auth/me) ──────────────────────

export async function getUserById(userId: string): Promise<{
  id: string; email: string; name: string; roles: UserRole[]; lastLoginAt?: Date;
}> {
  if (!Types.ObjectId.isValid(userId)) throw new NotFoundError('User', userId);
  const user = await User.findById(userId).exec();
  if (!user || !user.isActive) throw new NotFoundError('User', userId);
  return {
    id: String(user._id),
    email: user.email,
    name: user.name,
    roles: user.roles as UserRole[],
    lastLoginAt: user.lastLoginAt,
  };
}
