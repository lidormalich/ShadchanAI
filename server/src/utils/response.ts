// ═══════════════════════════════════════════════════════════
// ShadchanAI — Standard API response envelope
// ═══════════════════════════════════════════════════════════

import type { Response } from 'express';

export interface ResponseMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  [key: string]: unknown;
}

export interface ApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: ResponseMeta;
}

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
