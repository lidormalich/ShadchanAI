// ═══════════════════════════════════════════════════════════
// ShadchanAI — API-safe shared types
// These are DTOs and response shapes only.
// No Mongoose Documents, no internal DB details.
// ═══════════════════════════════════════════════════════════

/** Standard API response envelope */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: ApiMeta;
}

/** Pagination and metadata for list responses */
export interface ApiMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Paginated list request parameters */
export interface PaginationParams {
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
