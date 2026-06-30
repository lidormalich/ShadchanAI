// ═══════════════════════════════════════════════════════════
// Frontend types for the backend API envelope + shared DTOs.
// Envelope/meta/pagination types are sourced from @shadchanai/shared
// (the single source of truth) and re-exported here for stable imports.
// ═══════════════════════════════════════════════════════════

export type { ApiEnvelope, ApiMeta, PaginationQuery } from '@shadchanai/shared';

import type { ApiMeta } from '@shadchanai/shared';

export interface PageResponse<T> {
  items: T[];
  meta: ApiMeta;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
