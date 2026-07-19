// ═══════════════════════════════════════════════════════════
// Merge-guard contract for the Tier-1 (auto-merge) path. The phone in a
// shidduch card is the shadchan's SHARED "לפרטים" line, so a name+phone hit
// alone must not silently fuse two people. These guards — degenerate name and
// age compatibility — are what stop the "בוחניק בוחניק" fusion (a surname
// dropped into both name fields + the same shadchan number, ages 27 vs 35).
// ═══════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { isDegenerateName, agesCompatible } from './candidate.matcher.js';

describe('candidate.matcher — isDegenerateName', () => {
  it('flags first === last (the mis-extracted surname-in-both-fields case)', () => {
    expect(isDegenerateName('בוחניק', 'בוחניק')).toBe(true);
  });

  it('is whitespace/case insensitive', () => {
    expect(isDegenerateName(' בוחניק ', 'בוחניק')).toBe(true);
    expect(isDegenerateName('Cohen', 'cohen')).toBe(true);
  });

  it('does NOT flag a real distinct name', () => {
    expect(isDegenerateName('רינה', 'בוחניק')).toBe(false);
    expect(isDegenerateName('יעל', 'בוחניק')).toBe(false);
  });

  it('needs both parts — a name with no surname is not degenerate', () => {
    expect(isDegenerateName('רינה', undefined)).toBe(false);
    expect(isDegenerateName(undefined, 'בוחניק')).toBe(false);
  });
});

describe('candidate.matcher — agesCompatible (Tier-1 merge)', () => {
  it('rejects a wide gap between two same-surname cards (27 vs 35 → not merged)', () => {
    expect(agesCompatible(27, 35)).toBe(false);
  });

  it('allows a small drift (re-shared posts, a birthday ticking over)', () => {
    expect(agesCompatible(27, 27)).toBe(true);
    expect(agesCompatible(27, 28)).toBe(true);
    expect(agesCompatible(27, 29)).toBe(true);
  });

  it('allows the merge when either age is unknown (name+phone still strong)', () => {
    expect(agesCompatible(undefined, 30)).toBe(true);
    expect(agesCompatible(30, undefined)).toBe(true);
    expect(agesCompatible(undefined, undefined)).toBe(true);
  });
});
