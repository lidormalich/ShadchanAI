// ═══════════════════════════════════════════════════════════
// ShadchanAI — Rate Limiters
//
// Tiered by sensitivity:
//   - authRateLimiter    — login / bootstrap / password-change
//   - aiRateLimiter      — /api/ai/*
//   - defaultRateLimiter — general admin API
//
// (webhookRateLimiter retired — Baileys uses sockets, not inbound HTTP.)
//
// Keyed by user id when authenticated, else IP. This prevents one
// noisy IP from blocking legitimate authenticated traffic.
// ═══════════════════════════════════════════════════════════

import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env.js';

function keyByUserOrIp(req: Request): string {
  return req.user?.id ?? req.ip ?? 'unknown';
}

function baseConfig(perMinute: number): Partial<Options> {
  return {
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: keyByUserOrIp,
    message: {
      success: false,
      error: { code: 'rate_limited', message: 'Too many requests — please slow down.' },
    },
  };
}

export const authRateLimiter = rateLimit({
  ...baseConfig(env.RATE_LIMIT_AUTH_PER_MIN),
  // Always key auth endpoints by IP (the user isn't authenticated yet)
  keyGenerator: (req) => req.ip ?? 'unknown',
});

export const aiRateLimiter = rateLimit(baseConfig(env.RATE_LIMIT_AI_PER_MIN));

export const defaultRateLimiter = rateLimit(baseConfig(env.RATE_LIMIT_DEFAULT_PER_MIN));

