// ═══════════════════════════════════════════════════════════
// ShadchanAI — Standard API response envelope
// ═══════════════════════════════════════════════════════════

import type { Response } from 'express';
import type { ApiEnvelope, ApiMeta } from '@shadchanai/shared';

/** @deprecated use ApiMeta from @shadchanai/shared */
export type ResponseMeta = ApiMeta;

export type { ApiEnvelope, ApiMeta };

export function ok<T>(res: Response, data: T, meta?: ResponseMeta, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data, meta };
  res.status(status).json(body);
}

export function created<T>(res: Response, data: T, meta?: ResponseMeta): void {
  ok(res, data, meta, 201);
}

export function noContent(res: Response): void {
  res.status(204).end();
}
