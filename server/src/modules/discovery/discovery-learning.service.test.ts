import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

const sessionFindOneAndUpdate = vi.fn();
const sessionUpdateMany = vi.fn();
const sessionFind = vi.fn();
vi.mock('./discovery-session.model.js', () => ({
  DiscoverySession: {
    findOneAndUpdate: (...a: unknown[]) => sessionFindOneAndUpdate(...a),
    updateMany: (...a: unknown[]) => sessionUpdateMany(...a),
    find: (...a: unknown[]) => sessionFind(...a),
  },
}));

const ingestReasons = vi.fn();
vi.mock('../rejection-reasons/rejection-reason.service.js', () => ({
  ingestReasons: (...a: unknown[]) => ingestReasons(...a),
}));

const rebuildCandidateInsight = vi.fn();
vi.mock('../../services/ai/candidate-learning.service.js', () => ({
  rebuildCandidateInsight: (...a: unknown[]) => rebuildCandidateInsight(...a),
}));

import {
  foldSessionIntoLearning,
  sweepExpiredSessions,
  DISCOVERY_REASON_CATEGORY,
} from './discovery-learning.service.js';

const SESSION_ID = '607f1f77bcf86cd799439031';
const INTERNAL_ID = '507f1f77bcf86cd799439011';

function makeFoldableSession() {
  return {
    _id: new Types.ObjectId(SESSION_ID),
    internalCandidateId: new Types.ObjectId(INTERNAL_ID),
    cards: [
      { verdict: 'reject', reasonChips: ['הבדל גיל', 'מרחק גיאוגרפי'], reasonText: 'לא התחברתי' },
      { verdict: 'reject', reasonChips: undefined, reasonText: undefined }, // reject w/o reasons — nothing to bank
      { verdict: 'like' },
      { verdict: undefined },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ingestReasons.mockResolvedValue([{}, {}, {}]);
  rebuildCandidateInsight.mockResolvedValue({});
});

describe('foldSessionIntoLearning', () => {
  it('banks reject reasons as candidate-sourced and rebuilds the insight', async () => {
    sessionFindOneAndUpdate.mockReturnValue({ exec: vi.fn().mockResolvedValue(makeFoldableSession()) });

    const res = await foldSessionIntoLearning(SESSION_ID);
    expect(res.folded).toBe(true);
    expect(res.reasonsIngested).toBe(3);
    expect(res.insightRebuilt).toBe(true);

    // 2 chips + 1 free text from the first reject; the reason-less reject adds nothing.
    const inputs = ingestReasons.mock.calls[0]![0] as Array<{ category: string; text: string; source: string }>;
    expect(inputs).toHaveLength(3);
    expect(inputs.every((i) => i.category === DISCOVERY_REASON_CATEGORY && i.source === 'candidate')).toBe(true);
    expect(inputs.map((i) => i.text)).toEqual(['הבדל גיל', 'מרחק גיאוגרפי', 'לא התחברתי']);

    expect(rebuildCandidateInsight).toHaveBeenCalledWith(INTERNAL_ID);
  });

  it('is idempotent — a second fold (or a finish/job race loser) is a no-op', async () => {
    // The atomic learningFoldedAt claim returns null for the loser.
    sessionFindOneAndUpdate.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
    const res = await foldSessionIntoLearning(SESSION_ID);
    expect(res).toEqual({ folded: false, reasonsIngested: 0, insightRebuilt: false });
    expect(ingestReasons).not.toHaveBeenCalled();
    expect(rebuildCandidateInsight).not.toHaveBeenCalled();
  });

  it('an insight-rebuild failure (AI down) does NOT lose the fold — reasons are already banked', async () => {
    sessionFindOneAndUpdate.mockReturnValue({ exec: vi.fn().mockResolvedValue(makeFoldableSession()) });
    rebuildCandidateInsight.mockRejectedValue(new Error('ai_budget_exhausted'));

    const res = await foldSessionIntoLearning(SESSION_ID);
    expect(res.folded).toBe(true);
    expect(res.reasonsIngested).toBe(3);
    expect(res.insightRebuilt).toBe(false);
  });
});

describe('sweepExpiredSessions', () => {
  it('expires overdue sessions and folds only the ones with enough verdicts', async () => {
    sessionUpdateMany.mockReturnValue({ exec: vi.fn().mockResolvedValue({ modifiedCount: 2 }) });
    sessionFind.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: vi.fn().mockResolvedValue([
            { _id: new Types.ObjectId(SESSION_ID), cards: [{ verdict: 'like' }, { verdict: 'reject' }, { verdict: 'skip' }] },
            { _id: new Types.ObjectId(), cards: [{ verdict: 'like' }] }, // < 3 verdicts → not folded
          ]),
        }),
      }),
    });
    sessionFindOneAndUpdate.mockReturnValue({ exec: vi.fn().mockResolvedValue(makeFoldableSession()) });

    const res = await sweepExpiredSessions();
    expect(res.expired).toBe(2);
    expect(res.folded).toBe(1);
    expect(sessionFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
