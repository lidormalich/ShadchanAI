// ═══════════════════════════════════════════════════════════
// ShadchanAI — Validate Middleware Factory
//
// Usage:
//   router.post('/x', validate({ body: BodySchema }), handler);
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodType } from 'zod';
import { ValidationError } from '../utils/errors.js';
import { describeZodIssues } from '../utils/zod.js';

export interface ValidateSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export function validate(schemas: ValidateSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) {
        // Express 5 query is read-only in some configs; assign through cast
        (req as unknown as { validatedQuery: unknown }).validatedQuery = schemas.query.parse(req.query);
      }
      if (schemas.params) {
        (req as unknown as { validatedParams: unknown }).validatedParams = schemas.params.parse(req.params);
      }
      next();
    } catch (err) {
      // Turn request-validation failures into a descriptive ValidationError
      // (400) that names the offending field, instead of a flat "Invalid
      // request data". A raw ZodError from anywhere else is left to the global
      // handler, which now logs it.
      if (err instanceof ZodError) {
        next(new ValidationError(describeZodIssues(err), err.issues));
        return;
      }
      next(err);
    }
  };
}

/** Typed helpers to get validated inputs in controllers. */
export function getValidatedQuery<T>(req: Request): T {
  return (req as unknown as { validatedQuery: T }).validatedQuery ?? (req.query as T);
}

export function getValidatedParams<T>(req: Request): T {
  return (req as unknown as { validatedParams: T }).validatedParams ?? (req.params as T);
}
