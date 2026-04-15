// ═══════════════════════════════════════════════════════════
// ShadchanAI — Security Middleware Stack
//
//   - helmet: baseline safe HTTP headers
//   - cors:   explicit allow-list of origins (from env.CORS_ORIGINS)
//   - requestId: attach a uuid to each request for correlation
// ═══════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { corsOrigins } from '../config/env.js';

declare module 'express-serve-static-core' {
  interface Request {
    id?: string;
  }
}

export const helmetMiddleware: RequestHandler = helmet({
  contentSecurityPolicy: false, // APIs don't render HTML; disable CSP to avoid client confusion
  crossOriginEmbedderPolicy: false,
});

export const corsMiddleware: RequestHandler = cors({
  origin: (origin, callback) => {
    // Allow same-origin / server-to-server (no Origin header)
    if (!origin) return callback(null, true);
    if (corsOrigins.includes(origin) || corsOrigins.includes('*')) {
      return callback(null, true);
    }
    return callback(new Error(`Origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Dev-User', 'X-Dev-Roles', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
});

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.id = incoming && /^[a-zA-Z0-9-]{6,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
