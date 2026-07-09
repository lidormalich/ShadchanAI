// ═══════════════════════════════════════════════════════════
// ShadchanAI — Global Error Middleware
//
// Maps thrown errors to the standard API response envelope.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import type { ApiEnvelope } from '../utils/response.js';
import { createLogger } from '../utils/logger.js';
import { describeZodIssues } from '../utils/zod.js';

const log = createLogger('error-middleware');

export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // Raw Zod errors (e.g. a direct schema.parse in a handler). The `validate`
  // middleware already converts request-validation failures into a descriptive
  // ValidationError, so anything reaching here is worth logging — previously
  // these were swallowed with a flat 400 and no log, hiding the real field.
  if (err instanceof ZodError) {
    log.warn({ path: `${req.method} ${req.originalUrl}`, issues: err.issues }, 'zod validation error');
    const body: ApiEnvelope = {
      success: false,
      error: {
        code: 'validation_error',
        message: describeZodIssues(err),
        details: err.issues,
      },
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof AppError) {
    // Validation errors carry the offending field in details — log it so the
    // cause is visible server-side, not just in the client toast.
    if (err.code === 'validation_error') {
      log.warn({ path: `${req.method} ${req.originalUrl}`, message: err.message, details: err.details }, 'validation error');
    }
    const body: ApiEnvelope = {
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    };
    res.status(err.status).json(body);
    return;
  }

  // Mongo duplicate-key
  if (isDupKeyError(err)) {
    const body: ApiEnvelope = {
      success: false,
      error: { code: 'conflict', message: 'Resource already exists' },
    };
    res.status(409).json(body);
    return;
  }

  // Unknown — log + 500
  log.error({ err }, 'unhandled');
  const body: ApiEnvelope = {
    success: false,
    error: { code: 'internal_error', message: (err as Error)?.message ?? 'Internal server error' },
  };
  res.status(500).json(body);
}

function isDupKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; name?: string };
  return e.code === 11000 || (e.name === 'MongoServerError' && e.code === 11000);
}
