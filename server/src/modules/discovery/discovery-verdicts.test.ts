import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

const sessionFind = vi.fn();
vi.mock('./discovery-session.model.js', () => ({
  DiscoverySession: { find: (...a: unknown[]) => sessionFind(...a) },
}));

import {
  loadCandidateVerdictMap,
  loadCandidateVerdictMaps,
  getCandidateVerdictForPair,
  loadVerdictsForExternal,
} from './discovery-verdicts.js';

const INTERNAL_A = '507f1f77bcf86cd799439011';
const INTERNAL_B = '507f1f77bcf86cd799439012';
const EXT_1 = '607f1f77bcf86cd799439021';
const EXT_2 = '607f1f77bcf86cd799439022';

function stubSessions(rows: unknown[]) {
  sessionFind.mockReturnValue({
    sort: () => ({ select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(rows) }) }) }),
  });
}

function card(externalId: string, verdict?: string, chips?: string[], text?: string, at?: Date) {
  return {
    externalCandidateId: new Types.ObjectId(externalId),
    verdict,
    reasonChips: chips,
    reasonText: text,
    verdictAt: at,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('loadCandidateVerdictMaps', () => {
  it('groups verdicts per internal and concatenates chips + free text into reasons', async () => {
    stubSessions([
      {
        internalCandidateId: new Types.ObjectId(INTERNAL_A),
        cards: [
          card(EXT_1, 'reject', ['הבדל גיל'], 'רחוקה מדי', new Date('2026-07-01')),
          card(EXT_2, 'like'),
          card(EXT_2, undefined), // unanswered card is ignored
        ],
      },
      {
        internalCandidateId: new Types.ObjectId(INTERNAL_B),
        cards: [card(EXT_1, 'skip')],
      },
    ]);

    const maps = await loadCandidateVerdictMaps([INTERNAL_A, INTERNAL_B]);
    expect(maps.get(INTERNAL_A)?.get(EXT_1)).toMatchObject({
      verdict: 'reject',
      reasons: ['הבדל גיל', 'רחוקה מדי'],
    });
    expect(maps.get(INTERNAL_A)?.get(EXT_2)?.verdict).toBe('like');
    expect(maps.get(INTERNAL_B)?.get(EXT_1)?.verdict).toBe('skip');
  });

  it('later sessions overwrite older verdicts on the same pair (newest wins)', async () => {
    // find() sorts ascending by createdAt — the mock returns oldest first.
    stubSessions([
      { internalCandidateId: new Types.ObjectId(INTERNAL_A), cards: [card(EXT_1, 'reject', ['לא התחברתי'])] },
      { internalCandidateId: new Types.ObjectId(INTERNAL_A), cards: [card(EXT_1, 'like')] },
    ]);
    const map = await loadCandidateVerdictMap(INTERNAL_A);
    expect(map.get(EXT_1)?.verdict).toBe('like');
  });

  it('skips invalid ids without querying and returns an empty map', async () => {
    const maps = await loadCandidateVerdictMaps(['not-an-objectid']);
    expect(maps.size).toBe(0);
    expect(sessionFind).not.toHaveBeenCalled();
  });
});

describe('getCandidateVerdictForPair', () => {
  it('returns the specific pair verdict or undefined', async () => {
    stubSessions([
      { internalCandidateId: new Types.ObjectId(INTERNAL_A), cards: [card(EXT_1, 'like')] },
    ]);
    expect((await getCandidateVerdictForPair(INTERNAL_A, EXT_1))?.verdict).toBe('like');
    stubSessions([
      { internalCandidateId: new Types.ObjectId(INTERNAL_A), cards: [card(EXT_1, 'like')] },
    ]);
    expect(await getCandidateVerdictForPair(INTERNAL_A, EXT_2)).toBeUndefined();
  });
});

describe('loadVerdictsForExternal (reverse direction)', () => {
  it('keys by internal and ignores cards of OTHER externals in the same session', async () => {
    stubSessions([
      {
        internalCandidateId: new Types.ObjectId(INTERNAL_A),
        cards: [card(EXT_1, 'reject', ['סגנון דתי שונה']), card(EXT_2, 'like')],
      },
      {
        internalCandidateId: new Types.ObjectId(INTERNAL_B),
        cards: [card(EXT_1, 'like')],
      },
    ]);

    const map = await loadVerdictsForExternal(EXT_1);
    expect(map.get(INTERNAL_A)?.verdict).toBe('reject');
    expect(map.get(INTERNAL_B)?.verdict).toBe('like');
    // EXT_2's like never leaks into EXT_1's map.
    expect([...map.values()].every((v) => v.verdict !== undefined)).toBe(true);
    expect(map.size).toBe(2);
  });

  it('returns empty for an invalid id without querying', async () => {
    const map = await loadVerdictsForExternal('garbage');
    expect(map.size).toBe(0);
    expect(sessionFind).not.toHaveBeenCalled();
  });
});
