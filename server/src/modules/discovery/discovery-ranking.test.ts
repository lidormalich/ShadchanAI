import { describe, it, expect, vi } from 'vitest';

// The pure helpers under test import model/DB modules transitively;
// mock the heavy ones so the module loads without a DB connection.
vi.mock('../../models/index.js', () => ({
  InternalCandidate: {}, ExternalCandidate: {}, MatchSuggestion: {},
}));
vi.mock('./discovery-session.model.js', () => ({ DiscoverySession: {} }));
vi.mock('../settings/settings.service.js', () => ({ getSettingCached: vi.fn() }));
vi.mock('../../services/embedding/semantic-similarity.service.js', () => ({
  buildSemanticSimilarityMap: vi.fn(),
  loadExternalChunksMap: vi.fn(),
  cosine: vi.fn(),
}));
vi.mock('../../services/embedding/embedding.gate.js', () => ({ isSemanticEnabled: vi.fn() }));
vi.mock('../../services/embedding/embedding.provider.js', () => ({ getEmbeddingProvider: vi.fn() }));

import { applyTraitPicks, applyAvoidFilters, selectDiverse } from './discovery-ranking.service.js';
import type { MatchableInternal } from '../../services/matching/matching.types.js';
import { Types } from 'mongoose';

const baseInternal = {
  _id: 'i1', firstName: 'א', lastName: 'ב', gender: 'male',
  dateOfBirth: new Date('1995-01-01'),
  personalStatus: 'single', numberOfChildren: 0, readinessForMarriage: 'open',
  hardConstraints: [], softPreferences: [],
  openness: {
    openToOtherSectors: false, openToConverts: false,
    openToWithChildren: false, openToAgeDifference: false, openToLongDistance: false,
  },
  profileCompletion: 80, missingCriticalFields: [], sendReadinessBlockers: [],
  status: 'active', deferredSuggestionsCount: 0,
} as unknown as MatchableInternal;

describe('applyTraitPicks', () => {
  it('overrides age range and openness in memory without touching other fields', () => {
    const patched = applyTraitPicks(baseInternal, {
      ageMin: 24, ageMax: 30,
      openness: { openToDivorced: true },
    });
    expect(patched.agePreferences?.min).toBe(24);
    expect(patched.agePreferences?.max).toBe(30);
    expect(patched.openness.openToDivorced).toBe(true);
    expect(patched.openness.openToOtherSectors).toBe(false); // untouched
    expect(baseInternal.agePreferences).toBeUndefined();     // original unmutated
  });

  it('session soft preferences replace same-field profile entries and append new ones', () => {
    const withPrefs = {
      ...baseInternal,
      softPreferences: [
        { field: 'lifestyleTone', value: 'strict', importance: 'important' },
        { field: 'educationLevel', value: 'academic', importance: 'nice_to_have' },
      ],
    } as MatchableInternal;
    const patched = applyTraitPicks(withPrefs, {
      softPreferences: [{ field: 'lifestyleTone', value: 'moderate', importance: 'must_have' }],
    });
    const tones = patched.softPreferences?.filter((p) => p.field === 'lifestyleTone');
    expect(tones).toHaveLength(1);
    expect(tones?.[0]?.value).toBe('moderate');
    expect(patched.softPreferences?.some((p) => p.field === 'educationLevel')).toBe(true);
  });

  it('returns the matchable untouched when there are no picks', () => {
    expect(applyTraitPicks(baseInternal, undefined)).toBe(baseInternal);
  });
});

type PoolItem = Parameters<typeof applyAvoidFilters>[0][number];

function ext(over: Partial<PoolItem>): PoolItem {
  return { _id: new Types.ObjectId(), ...over } as PoolItem;
}

describe('applyAvoidFilters', () => {
  const pool = [
    ext({ personalStatus: 'divorced', age: 30 }),
    ext({ personalStatus: 'single', age: 24, region: 'south' }),
    ext({ personalStatus: 'single', age: 36, numberOfChildren: 2 }),
  ];

  it('filters by allow-listed fields', () => {
    expect(applyAvoidFilters(pool, [{ field: 'personalStatus', value: 'divorced' }])).toHaveLength(2);
    expect(applyAvoidFilters(pool, [{ field: 'maxAge', value: '30' }])).toHaveLength(2);
    expect(applyAvoidFilters(pool, [{ field: 'minAge', value: '30' }])).toHaveLength(2);
    expect(applyAvoidFilters(pool, [{ field: 'region', value: 'south' }])).toHaveLength(2);
    expect(applyAvoidFilters(pool, [{ field: 'withChildren', value: 'avoid' }])).toHaveLength(2);
  });

  it('drops unknown fields instead of applying them (AI cannot widen its powers)', () => {
    expect(applyAvoidFilters(pool, [{ field: 'phone', value: 'x' }])).toHaveLength(3);
    expect(applyAvoidFilters(pool, [{ field: '$where', value: '1' }])).toHaveLength(3);
  });

  it('is a no-op with no filters', () => {
    expect(applyAvoidFilters(pool, undefined)).toBe(pool);
    expect(applyAvoidFilters(pool, [])).toBe(pool);
  });
});

describe('selectDiverse (MMR)', () => {
  type Ranked = Parameters<typeof selectDiverse>[0][number];
  const mk = (score: number, over: Partial<PoolItem>): Ranked => ({
    ext: ext(over),
    engineScore: score,
    strengths: [],
    finalRank: score,
  });

  it('with high λ, exploration picks across buckets instead of the top-scored clones', () => {
    // 4 near-identical high scorers + 2 different lower scorers.
    const ranked = [
      mk(90, { age: 25, sectorGroup: 'haredi', personalStatus: 'single', region: 'jerusalem' }),
      mk(89, { age: 25, sectorGroup: 'haredi', personalStatus: 'single', region: 'jerusalem' }),
      mk(88, { age: 26, sectorGroup: 'haredi', personalStatus: 'single', region: 'jerusalem' }),
      mk(87, { age: 25, sectorGroup: 'haredi', personalStatus: 'single', region: 'jerusalem' }),
      mk(70, { age: 33, sectorGroup: 'dati_leumi', personalStatus: 'divorced', region: 'south' }),
      mk(65, { age: 40, sectorGroup: 'masorti', personalStatus: 'single', region: 'north' }),
    ];
    const picked = selectDiverse(ranked, 3, 0.45);
    const sectors = new Set(picked.map((p) => p.ext.sectorGroup));
    // Aggressive exploration must NOT return three haredi-jerusalem clones.
    expect(sectors.size).toBeGreaterThan(1);
    // The top-scored card still leads.
    expect(picked[0]?.finalRank).toBe(90);
  });

  it('with λ→0, selection converges to pure rank order', () => {
    const ranked = [
      mk(90, { age: 25, sectorGroup: 'haredi' }),
      mk(80, { age: 40, sectorGroup: 'masorti' }),
      mk(85, { age: 25, sectorGroup: 'haredi' }),
    ];
    const picked = selectDiverse(ranked, 2, 0);
    expect(picked.map((p) => p.finalRank)).toEqual([90, 85]);
  });

  it('returns everything sorted when the pool is smaller than the ask', () => {
    const ranked = [mk(50, { age: 20 }), mk(70, { age: 30 })];
    const picked = selectDiverse(ranked, 5, 0.45);
    expect(picked.map((p) => p.finalRank)).toEqual([70, 50]);
  });
});
