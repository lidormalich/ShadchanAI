// ═══════════════════════════════════════════════════════════
// ShadchanAI — Global Error Middleware
//
// Maps thrown errors to the standard API response envelope.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import type { ApiEnvelope } from '../utils/response.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  // Zod validation errors
  if (err instanceof ZodError) {
    const body: ApiEnvelope = {
      success: false,
      error: {
        code: 'validation_error',
        message: 'Invalid request data',
        details: err.issues,
      },
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof AppError) {
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
  console.error('[error-middleware] unhandled:', err);
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
