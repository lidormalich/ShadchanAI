// ═══════════════════════════════════════════════════════════
// ShadchanAI — API-safe shared types
// These are DTOs and response shapes only.
// No Mongoose Documents, no internal DB details.
// ═══════════════════════════════════════════════════════════

/** Structured API error payload (matches the live server envelope) */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

/** Pagination and metadata for list responses */
export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  [key: string]: unknown;
}

/** Standard API response envelope */
export interface ApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: ApiMeta;
}

/** Paginated list request parameters */
export interface PaginationQuery {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

/** Score breakdown for a single scoring dimension */
export interface ScoreDimensionResult {
  dimension: string;
  score: number;
  weight: number;
  weightedScore: number;
  detail?: string;
}
