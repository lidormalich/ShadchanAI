// ═══════════════════════════════════════════════════════════
// ShadchanAI — Auth Middleware
//
// Real JWT verification is now the primary path. The X-Dev-User
// fallback is gated behind env.AUTH_DEV_HEADER_ALLOWED, which is
// false in production (enforced by env validation).
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { verifyToken } from '../modules/auth/auth.service.js';
import { UnauthorizedError } from '../utils/errors.js';
import type { UserRole } from '../models/index.js';

export interface AuthUser {
  id: string;
  roles: UserRole[];
  email?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const user = extractUser(req);
  if (!user) {
    next(new UnauthorizedError('Authentication required'));
    return;
  }
  req.user = user;
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const user = extractUser(req);
  if (user) req.user = user;
  next();
}

function extractUser(req: Request): AuthUser | null {
  // ── 1. JWT bearer token (canonical path) ─────────────
  const authHeader = req.header('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    const payload = verifyToken(token);
    if (payload && Types.ObjectId.isValid(payload.sub)) {
      return {
        id: payload.sub,
        roles: payload.roles ?? ['shadchan'],
        email: payload.email,
      };
    }
  }

  // ── 2. Dev fallback (development + opt-in only) ──────
  // Never fires in production (env.AUTH_DEV_HEADER_ALLOWED is
  // forced false by env validation when NODE_ENV=production).
  if (env.AUTH_DEV_HEADER_ALLOWED) {
    const devUserId = req.header('x-dev-user');
    if (devUserId && Types.ObjectId.isValid(devUserId)) {
      const devRoles = (req.header('x-dev-roles') ?? 'admin,shadchan')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean) as UserRole[];
      return { id: devUserId, roles: devRoles };
    }
  }

  return null;
}
