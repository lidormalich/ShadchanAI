// ═══════════════════════════════════════════════════════════
// Shared date/time formatting helpers (he-IL locale).
// Replaces inline `new Date(x).toLocaleString('he-IL')` usages.
// All return an em-dash placeholder for empty/invalid input.
// ═══════════════════════════════════════════════════════════

const PLACEHOLDER = '—';

/** Date + time, e.g. "30.6.2026, 14:05". */
export function formatDateTime(value?: string | number | Date | null): string {
  if (!value) return PLACEHOLDER;
  return new Date(value).toLocaleString('he-IL');
}

/** Date only, e.g. "30.6.2026". */
export function formatDate(value?: string | number | Date | null): string {
  if (!value) return PLACEHOLDER;
  return new Date(value).toLocaleDateString('he-IL');
}

/** Time only, e.g. "14:05:32". */
export function formatTime(value?: string | number | Date | null): string {
  if (!value) return PLACEHOLDER;
  return new Date(value).toLocaleTimeString('he-IL');
}
