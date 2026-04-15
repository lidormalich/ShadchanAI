// ═══════════════════════════════════════════════════════════
// ShadchanAI — Permission Helpers
//
// Scaffolded role-based permission checks. Every sensitive
// mutation should go through one of these helpers so that
// when a proper auth / roles table lands, enforcement tightens
// automatically without changing service/controller code.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';
import type { AuthUser } from './auth.middleware.js';

export type Role = 'admin' | 'shadchan' | 'viewer';

/** Inline helper used inside services for permission checks. */
export function ensureUser(user: AuthUser | undefined): AuthUser {
  if (!user) throw new UnauthorizedError();
  return user;
}

export function hasRole(user: AuthUser | undefined, role: Role): boolean {
  return Boolean(user?.roles?.includes(role));
}

export function ensureRole(user: AuthUser | undefined, role: Role): AuthUser {
  const u = ensureUser(user);
  if (!hasRole(u, role)) throw new ForbiddenError(`Requires role: ${role}`);
  return u;
}

export function ensureAnyRole(user: AuthUser | undefined, roles: Role[]): AuthUser {
  const u = ensureUser(user);
  if (!roles.some((r) => u.roles.includes(r))) {
    throw new ForbiddenError(`Requires one of: ${roles.join(', ')}`);
  }
  return u;
}

/** Express middleware to gate whole routers by role. */
export function requireRole(role: Role) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      ensureRole(req.user, role);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Convenience: admins or shadchanim can write. */
export const canWriteCandidates = (user: AuthUser | undefined): void => {
  ensureAnyRole(user, ['admin', 'shadchan']);
};

export const canManageChannels = (user: AuthUser | undefined): void => {
  ensureRole(user, 'admin');
};

export const canApproveMatches = (user: AuthUser | undefined): void => {
  ensureAnyRole(user, ['admin', 'shadchan']);
};
