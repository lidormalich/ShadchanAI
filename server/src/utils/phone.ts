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

// ── Labeled phone entries (multi-phone per candidate) ──────
//
// A candidate accumulates numbers over time: the card's inquiry line,
// numbers arriving from merged duplicate cards, a reference phone, and
// manual additions. Each entry keeps an optional label ("אמא", "שדכנית")
// and a source tag. Dedup key is the normalized E.164 form; when a raw
// value can't be canonicalized we fall back to its digit string so two
// visually-different spellings of the same number still converge.

export interface PhoneEntry {
  number: string;
  normalized?: string;
  label?: string;
  source?: string;
}

function phoneKey(number: string, normalized?: string | null): string {
  return normalized ?? String(number).replace(/[^\d]/g, '');
}

/**
 * Merge additional phones into an existing entry list without ever
 * dropping a number. Duplicates (by normalized form) collapse into the
 * existing entry; a label fills in only when the existing entry has none,
 * so an operator-written label is never overwritten by a merge.
 */
export function mergePhoneEntries(
  existing: PhoneEntry[] | undefined,
  additions: Array<{ number?: string | null; label?: string; source?: string }>,
): PhoneEntry[] {
  const out: PhoneEntry[] = [];
  const byKey = new Map<string, PhoneEntry>();
  const push = (a: { number?: string | null; label?: string; source?: string; normalized?: string }): void => {
    const number = a.number ? String(a.number).trim() : '';
    if (!number) return;
    const normalized = a.normalized ?? normalizePhone(number) ?? undefined;
    const key = phoneKey(number, normalized);
    const cur = byKey.get(key);
    if (cur) {
      if (!cur.label && a.label) cur.label = a.label;
      return;
    }
    const entry: PhoneEntry = { number, normalized, label: a.label || undefined, source: a.source || undefined };
    out.push(entry);
    byKey.set(key, entry);
  };
  for (const e of existing ?? []) push(e);
  for (const a of additions) push(a);
  return out;
}
