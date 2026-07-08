import { describe, it, expect } from 'vitest';
import { wordsMatch } from './search.service.js';

describe('wordsMatch', () => {
  it('requires each word to hit some field (AND across words, OR across fields)', () => {
    const filter = wordsMatch('אפרת חנימוב', ['firstName', 'lastName']);
    expect(filter).toEqual({
      $and: [
        { $or: [{ firstName: /אפרת/i }, { lastName: /אפרת/i }] },
        { $or: [{ firstName: /חנימוב/i }, { lastName: /חנימוב/i }] },
      ],
    });
  });

  it('single word → one $and clause over all fields', () => {
    const filter = wordsMatch('אפרת', ['firstName', 'lastName']) as { $and: unknown[] };
    expect(filter.$and).toHaveLength(1);
  });

  it('collapses extra whitespace between words', () => {
    const filter = wordsMatch('  אפרת   חנימוב  ', ['firstName']) as { $and: unknown[] };
    expect(filter.$and).toHaveLength(2);
  });

  it('empty query → no constraint', () => {
    expect(wordsMatch('   ', ['firstName'])).toEqual({});
  });

  it('escapes regex metacharacters in a term', () => {
    const filter = wordsMatch('a.b', ['firstName']) as { $and: Array<{ $or: Array<{ firstName: RegExp }> }> };
    expect(filter.$and[0]!.$or[0]!.firstName.source).toBe('a\\.b');
  });
});
