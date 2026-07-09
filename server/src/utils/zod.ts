// ═══════════════════════════════════════════════════════════
// Turn a ZodError into a human-readable, field-naming message.
//
// The old global handler returned a flat "Invalid request data" for
// EVERY validation failure, which hid which field was actually rejected.
// This names the offending path(s) so the operator (and the logs) can
// see exactly what was wrong — e.g. "query.limit: Number must be <= 50".
// ═══════════════════════════════════════════════════════════

import type { ZodError } from 'zod';

const MAX_ISSUES = 5;

export function describeZodIssues(err: ZodError): string {
  const parts = err.issues.slice(0, MAX_ISSUES).map((i) => {
    const path = i.path.join('.') || '(root)';
    return `${path}: ${i.message}`;
  });
  const more = err.issues.length > MAX_ISSUES ? ` (+${err.issues.length - MAX_ISSUES} נוספים)` : '';
  return `נתוני הבקשה שגויים — ${parts.join('; ')}${more}`;
}
