// ═══════════════════════════════════════════════════════════
// ShadchanAI — Pagination helpers
// ═══════════════════════════════════════════════════════════

import { z } from 'zod';
import { PAGINATION } from '../config/constants.js';

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(PAGINATION.DEFAULT_PAGE),
  limit: z.coerce.number().int().positive().max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export interface PageResult<T> {
  items: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export function toSkipLimit(q: PaginationQuery): { skip: number; limit: number } {
  return { skip: (q.page - 1) * q.limit, limit: q.limit };
}

export function buildSort(q: PaginationQuery, fallbackField = 'createdAt'): Record<string, 1 | -1> {
  const field = q.sort ?? fallbackField;
  return { [field]: q.order === 'asc' ? 1 : -1 };
}

export function makeMeta(page: number, limit: number, total: number): PageResult<never>['meta'] {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
