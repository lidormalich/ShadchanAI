import { ApiError } from '@/types/api';

// True when the failure is a 404 (or the backend's not_found envelope) —
// lets detail pages show a friendly "X not found" instead of a generic error.
export function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.code === 'not_found');
}

// Human-readable error text for a toast. For a server validation_error
// the envelope carries the Zod issues in `details` — surface the offending
// field(s) instead of the generic "Invalid request data", so the operator
// (and we) can see exactly what was rejected.
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = err.details;
    if (Array.isArray(issues) && issues.length > 0) {
      const parts = issues
        .slice(0, 5)
        .map((raw) => {
          const i = raw as { path?: unknown[]; message?: string };
          const path = Array.isArray(i.path) ? i.path.join('.') : '';
          return path ? `${path}: ${i.message ?? ''}` : (i.message ?? '');
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join('\n');
    }
    return err.message;
  }
  return (err as Error)?.message ?? 'שגיאה לא ידועה';
}
