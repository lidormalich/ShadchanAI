// ═══════════════════════════════════════════════════════════
// Candidate identity key.
//
// A deterministic key that collapses the SAME person (name + age)
// to one string, so a DB-level unique index can guarantee that a
// profile re-posted several times in quick succession can only ever
// create ONE candidate — the concurrent-repost race that used to
// mint 2-3 identical cards.
//
// Scope of the key (intentionally narrow):
//   - Requires firstName + lastName + age. Missing any → no key
//     (undefined), so those candidates are NOT constrained here and
//     fall back to the matcher's name-only "suspected duplicate" route.
//   - Age is EXACT (not ±1). The fuzzy ±1 / name-only cases are the
//     matcher's job (they land in the duplicates review tab). The key
//     is the deterministic backstop for the identical-repost race, not
//     a replacement for that human-reviewed near-duplicate detection.
//
// Name normalization mirrors phone canonicalization in spirit: strip
// the noise (niqqud, gershayim, quotes, dashes, dots, casing, extra
// whitespace) so "יוֹסֵף", "יוסף", "יוסף " all converge.
// ═══════════════════════════════════════════════════════════

/** Normalize one name part for identity comparison. Returns '' for empty. */
export function normalizeNamePart(raw: string | undefined | null): string {
  if (!raw) return '';
  return String(raw)
    .normalize('NFKC')
    .replace(/[֑-ׇ]/g, '') // Hebrew niqqud / te'amim
    .replace(/[׳״"'`.\-]/g, '') // gershayim, quotes, dots, dashes
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Build the identity key from name + age. Returns undefined when any of
 * firstName / lastName / age is missing — callers must treat undefined as
 * "not constrained" (the partial unique index only covers documents that
 * actually have a key).
 */
export function buildIdentityKey(
  firstName: string | undefined | null,
  lastName: string | undefined | null,
  age: number | undefined | null,
): string | undefined {
  const first = normalizeNamePart(firstName);
  const last = normalizeNamePart(lastName);
  if (!first || !last || !age || !Number.isFinite(age)) return undefined;
  return `${first}|${last}|${age}`;
}
