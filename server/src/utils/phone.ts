// ═══════════════════════════════════════════════════════════
// Phone canonicalization (Phase 7 hardening).
//
// Normalizes Israeli-format numbers to E.164 so duplicate
// detection across "+972501234567", "972501234567",
// "050-1234567", "050 1234 567" all converge to one value.
//
// Design:
//   - Input is cleaned of every non-digit + leading '+'.
//   - A leading "0" is treated as the Israeli national prefix
//     and replaced by "972".
//   - Numbers already beginning with "972" pass through.
//   - Any other international prefix (e.g., "1…" for US) is
//     kept as-is so non-Israeli numbers are not misclassified.
//   - Output is '+' + digits (E.164 shape).
//
// Returns null for inputs we cannot confidently canonicalize —
// callers should fall back to the raw value for storage but
// NOT use the null for dedup lookups.
// ═══════════════════════════════════════════════════════════

const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

export function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  // Strip whitespace, dashes, parens, dots, and a leading '+'.
  const digits = String(raw).replace(/[^\d]/g, '');
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;

  // Israeli national format — leading 0.
  if (digits.startsWith('0')) {
    return '+972' + digits.slice(1);
  }

  // Already international: keep as-is.
  return '+' + digits;
}

/**
 * Normalize an array of phones. Drops nulls and de-duplicates the
 * resulting canonical values. Useful for ExternalCandidate imports
 * where regex/AI may supply multiple candidate phones.
 */
export function normalizePhones(raw: Array<string | undefined | null> | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  const out = new Set<string>();
  for (const p of raw) {
    const n = normalizePhone(p);
    if (n) out.add(n);
  }
  return [...out];
}
