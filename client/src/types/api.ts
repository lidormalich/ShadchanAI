// ═══════════════════════════════════════════════════════════
// Frontend types for the backend API envelope + shared DTOs.
// Mirrors server/src/utils/response.ts.
// ═══════════════════════════════════════════════════════════

export interface ApiMeta {
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
  meta?: ApiMeta;
}

export interface PageResponse<T> {
  items: T[];
  meta: ApiMeta;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
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
