import { describe, it, expect, vi, beforeEach } from 'vitest';

const internalFindById = vi.fn();
const sessionFindOne = vi.fn();
vi.mock('../../models/index.js', () => ({
  InternalCandidate: { findById: (...a: unknown[]) => internalFindById(...a) },
  DiscoverySession: { findOne: (...a: unknown[]) => sessionFindOne(...a) },
}));

const updateInternalCandidate = vi.fn();
vi.mock('../candidates/internal-candidate.service.js', () => ({
  updateInternalCandidate: (...a: unknown[]) => updateInternalCandidate(...a),
}));

import { buildProfileProposal, applyProfileProposal } from './discovery-profile.service.js';
import { BusinessRuleError } from '../../utils/errors.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';

const INTERNAL_ID = '507f1f77bcf86cd799439011';
const USER = { id: '507f1f77bcf86cd799439012', roles: ['shadchan'] } as unknown as AuthUser;

function stubInternal(doc: unknown) {
  // Supports both chains: .lean().exec() (proposal) and
  // .select().lean().exec() (openness expansion at apply time).
  const leanChain = { lean: () => ({ exec: vi.fn().mockResolvedValue(doc) }) };
  internalFindById.mockReturnValue({ ...leanChain, select: () => leanChain });
}
function stubSession(doc: unknown) {
  sessionFindOne.mockReturnValue({
    sort: () => ({ select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(doc) }) }) }),
  });
}

const BASE_INTERNAL = {
  _id: INTERNAL_ID,
  agePreferences: { min: 20, max: 30, flexibility: 'strict' },
  locationPreferences: { regions: ['jerusalem'] },
  openness: { openToDivorced: false, openToOtherSectors: false },
  softPreferences: [{ field: 'lifestyleTone', value: 'strict', importance: 'important' }],
};

beforeEach(() => vi.clearAllMocks());

describe('buildProfileProposal', () => {
  it('returns no_sessions when the candidate never completed a wizard', async () => {
    stubInternal(BASE_INTERNAL);
    stubSession(null);
    const p = await buildProfileProposal(INTERNAL_ID);
    expect(p).toMatchObject({ available: false, reason: 'no_sessions', changes: [] });
  });

  it('returns no_changes when the revealed picks already match the profile', async () => {
    stubInternal(BASE_INTERNAL);
    stubSession({
      traitPicks: { ageMin: 20, ageMax: 30, regions: ['jerusalem'], openness: { openToDivorced: false } },
      aiSummaries: [],
      counters: { liked: 2, rejected: 3 },
    });
    const p = await buildProfileProposal(INTERNAL_ID);
    expect(p).toMatchObject({ available: false, reason: 'no_changes' });
  });

  it('diffs age / regions / openness / soft prefs into discrete changes', async () => {
    stubInternal(BASE_INTERNAL);
    stubSession({
      traitPicks: {
        ageMin: 22, ageMax: 28,                       // differs
        regions: ['jerusalem', 'gush_dan'],           // adds one
        openness: { openToDivorced: true },           // flips
        softPreferences: [{ field: 'lifestyleTone', value: 'moderate', importance: 'must_have' }],
      },
      aiSummaries: [{ summary: 'מחפש בית חם', positiveSignals: [], negativeSignals: [], avoidFilters: [], confidence: 0.6, at: new Date() }],
      counters: { liked: 4, rejected: 5 },
      finishedAt: new Date(),
    });

    const p = await buildProfileProposal(INTERNAL_ID);
    expect(p.available).toBe(true);
    const keys = p.changes.map((c) => c.key).sort();
    expect(keys).toEqual(['agePreferences', 'openness.openToDivorced', 'regions', 'softPreferences']);

    const age = p.changes.find((c) => c.key === 'agePreferences')!;
    expect(age.patch).toEqual({ agePreferences: { min: 22, max: 28, flexibility: 'strict' } });

    const regions = p.changes.find((c) => c.key === 'regions')!;
    // Additive union — the stated region is never removed.
    expect((regions.patch['locationPreferences'] as { regions: string[] }).regions)
      .toEqual(['jerusalem', 'gush_dan']);

    const soft = p.changes.find((c) => c.key === 'softPreferences')!;
    expect(soft.patch['softPreferences']).toEqual([
      { field: 'lifestyleTone', value: 'moderate', importance: 'must_have' },
    ]);

    expect(p.basedOn?.learnedSummary).toBe('מחפש בית חם');
  });
});

describe('applyProfileProposal', () => {
  const SESSION_WITH_CHANGES = {
    traitPicks: { ageMin: 22, ageMax: 28, openness: { openToDivorced: true, openToOtherSectors: true } },
    aiSummaries: [],
    counters: { liked: 1, rejected: 1 },
  };

  it('applies ONLY the accepted keys, merging same-object fragments', async () => {
    stubInternal(BASE_INTERNAL);
    stubSession(SESSION_WITH_CHANGES);
    updateInternalCandidate.mockResolvedValue({});

    const res = await applyProfileProposal(
      INTERNAL_ID,
      ['openness.openToDivorced', 'openness.openToOtherSectors'],
      USER,
    );
    expect(res.applied.sort()).toEqual(['openness.openToDivorced', 'openness.openToOtherSectors']);

    const patch = updateInternalCandidate.mock.calls[0]![1] as Record<string, unknown>;
    // Both flags deep-merged onto one openness object; age NOT applied.
    expect(patch['openness']).toMatchObject({ openToDivorced: true, openToOtherSectors: true });
    expect(patch['agePreferences']).toBeUndefined();
  });

  it('rejects when nothing valid was accepted', async () => {
    stubInternal(BASE_INTERNAL);
    stubSession(SESSION_WITH_CHANGES);
    await expect(applyProfileProposal(INTERNAL_ID, ['nonexistent.key'], USER))
      .rejects.toBeInstanceOf(BusinessRuleError);
    expect(updateInternalCandidate).not.toHaveBeenCalled();
  });
});
