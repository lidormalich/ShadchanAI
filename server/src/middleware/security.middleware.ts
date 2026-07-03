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
    // Disallowed origin: DO NOT throw. Throwing here surfaces as a 500 from
    // the error middleware on EVERY request that carries an Origin header —
    // including the browser's own same-origin requests for module scripts and
    // stylesheets (Vite marks them crossorigin, so the browser sends Origin
    // even same-origin). That crashed all static asset loads under single-
    // origin hosting. Returning `false` simply omits the CORS headers: same-
    // origin requests don't need them and proceed normally (200), while a
    // genuine cross-origin caller is still blocked by the browser.
    return callback(null, false);
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
