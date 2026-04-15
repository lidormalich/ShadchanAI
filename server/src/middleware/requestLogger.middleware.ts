// ═══════════════════════════════════════════════════════════
// ShadchanAI — Request Logger
//
// Structured per-request log line:
//   method, path, status, durationMs, requestId, userId?
//
// Skips /api/health and /api/readiness to keep log noise down.
// ═══════════════════════════════════════════════════════════

import type { NextFunction, Request, Response } from 'express';

const SKIP_PATHS = new Set(['/api/health', '/api/readiness']);

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const path = req.path;
  if (SKIP_PATHS.has(path)) return next();

  res.on('finish', () => {
    const line = {
      scope: 'http',
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      ts: new Date().toISOString(),
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - start,
      requestId: req.id,
      userId: req.user?.id,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  });

  next();
}
