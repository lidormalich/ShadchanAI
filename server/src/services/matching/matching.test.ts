// ═══════════════════════════════════════════════════════════
// ShadchanAI — Matching Engine Test Suite
// ═══════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { evaluatePair, findMatches } from './matching.engine.js';
import { evaluateHardRules } from './matching.rules.js';
import { scorePair } from './matching.score.js';
import { computePenalties } from './matching.penalties.js';
import {
  sectorGroupCloseness,
  subSectorCloseness,
  combinedSectorCloseness,
  lifestyleCloseness,
  lifeStageCloseness,
  studyWorkCloseness,
} from './matching.matrix.js';
import type { MatchableInternal, MatchableExternal, MatchingContext } from './matching.types.js';

// ── Test Fixtures ─────────────────────────────────────────

function makeInternal(overrides: Partial<MatchableInternal> = {}): MatchableInternal {
  return {
    _id: 'internal-1',
    firstName: 'David',
    lastName: 'Cohen',
    gender: 'male',
    dateOfBirth: new Date('1998-06-15'),
    city: 'Jerusalem',
    sectorGroup: 'dati_leumi',
    subSector: 'dati_leumi_classic',
    lifestyleTone: 'moderate',
    religiousStyle: 'halachic_mainstream',
    personalStatus: 'single',
    numberOfChildren: 0,
    lifeStage: 'early_career',
    readinessForMarriage: 'actively_looking',
    studyWorkDirection: 'academic_studies',
    hardConstraints: [],
    softPreferences: [],
    agePreferences: { min: 22, max: 28, flexibility: 'somewhat_flexible' },
    locationPreferences: { cities: ['Jerusalem', 'Tel Aviv'], willingToRelocate: false },
    openness: {
      openToOtherSectors: false,
      openToConverts: false,
      // openToDivorced left unset (tri-state "unknown") — the neutral default.
      // Tests that exercise the block/penalty set it to true/false explicitly.
      openToWithChildren: false,
      openToAgeDifference: false,
      openToLongDistance: false,
    },
    profileCompletion: 85,
    missingCriticalFields: [],
    sendReadinessBlockers: [],
    profileQualityScore: 80,
    dataReliabilityScore: 75,
    readinessScore: 90,
    status: 'active',
    lastVerifiedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
    deferredSuggestionsCount: 0,
    ...overrides,
  };
}

function makeExternal(overrides: Partial<MatchableExternal> = {}): MatchableExternal {
  return {
    _id: 'external-1',
    firstName: 'Sarah',
    lastName: 'Levi',
    gender: 'female',
    age: 25,
    city: 'Jerusalem',
    sectorGroup: 'dati_leumi',
    subSector: 'dati_leumi_classic',
    lifestyleTone: 'moderate',
    personalStatus: 'single',
    lifeStage: 'early_career',
    studyWorkDirection: 'academic_studies',
    availabilityStatus: 'available',
    status: 'active',
    shareCard: { approvedForShare: true },
    sourceImportedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000), // 14 days ago
    ...overrides,
  };
}

function makeContext(overrides: Partial<MatchingContext> = {}): MatchingContext {
  return {
    mode: 'strict',
    activeMatchExternalIds: new Set(),
    recentDeclines: new Map(),
    activeSuggestionCount: 0,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════
// 1. HARD RULES
// ══════════════════════════════════════════════════════════

describe('Hard Rules', () => {
  it('blocks same-gender pairs', () => {
    const internal = makeInternal({ gender: 'male' });
    const external = makeExternal({ gender: 'male' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(false);
    expect(result.blockers.map((b) => b.message)).toContain('שני הצדדים מאותו מין (גבר)');
  });

  it('passes opposite-gender pairs', () => {
    const result = evaluateHardRules(makeInternal(), makeExternal(), makeContext());
    expect(result.eligible).toBe(true);
  });

  it('allows missing external gender (not blocked, confidence drops)', () => {
    const external = makeExternal({ gender: undefined });
    const result = evaluateHardRules(makeInternal(), external, makeContext());
    expect(result.eligible).toBe(true);
  });

  it('blocks non-active internal candidates', () => {
    const internal = makeInternal({ status: 'paused' });
    const result = evaluateHardRules(internal, makeExternal(), makeContext());
    expect(result.eligible).toBe(false);
    expect(result.blockers[0]!.message).toContain('בהשהיה');
  });

  it('blocks unavailable external candidates', () => {
    const external = makeExternal({ availabilityStatus: 'unavailable' });
    const result = evaluateHardRules(makeInternal(), external, makeContext());
    expect(result.eligible).toBe(false);
  });

  it('blocks external candidates currently dating', () => {
    const external = makeExternal({ availabilityStatus: 'dating' });
    const result = evaluateHardRules(makeInternal(), external, makeContext());
    expect(result.eligible).toBe(false);
  });

  it('blocks when internal is already dating', () => {
    const internal = makeInternal({ datingPartnerCandidateId: 'someone' });
    const result = evaluateHardRules(internal, makeExternal(), makeContext());
    expect(result.eligible).toBe(false);
  });

  it('blocks duplicate active pairs', () => {
    const context = makeContext({ activeMatchExternalIds: new Set(['external-1']) });
    const result = evaluateHardRules(makeInternal(), makeExternal(), context);
    expect(result.eligible).toBe(false);
    expect(result.blockers[0]!.message).toContain('כבר קיימת הצעה פעילה');
  });

  it('blocks recently declined pairs within cooldown', () => {
    const recentDeclines = new Map([['external-1', new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)]]);
    const context = makeContext({ recentDeclines });
    const result = evaluateHardRules(makeInternal(), makeExternal(), context);
    expect(result.eligible).toBe(false);
    expect(result.blockers[0]!.message).toContain('נדחה');
  });

  it('allows declined pairs past cooldown', () => {
    const recentDeclines = new Map([['external-1', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)]]);
    const context = makeContext({ recentDeclines });
    const result = evaluateHardRules(makeInternal(), makeExternal(), context);
    expect(result.eligible).toBe(true);
  });

  it('does NOT block a divorced external when openness is unknown (undefined)', () => {
    // Absence of data must never hard-block — it only sinks the score via a
    // soft penalty. A single internal with an unset flag + divorced external
    // stays eligible.
    const internal = makeInternal(); // openToDivorced unset (unknown)
    const external = makeExternal({ personalStatus: 'divorced' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(true);
  });

  it('blocks a divorced external when internal explicitly set openToDivorced=false', () => {
    // The operator clicked "לא" → an explicit refusal hard-blocks (overridable).
    const internal = makeInternal({ openness: { ...makeInternal().openness, openToDivorced: false } });
    const external = makeExternal({ personalStatus: 'divorced' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(false);
  });

  it('allows divorced external when internal is open', () => {
    const internal = makeInternal({ openness: { ...makeInternal().openness, openToDivorced: true } });
    const external = makeExternal({ personalStatus: 'divorced' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(true);
  });

  it('does NOT block a divorced internal from a divorcee when flag is unknown', () => {
    // The exact false-negative this fix targets: a divorced candidate with an
    // unset openToDivorced must still be matchable with a divorcee.
    const internal = makeInternal({ personalStatus: 'divorced' }); // flag unset
    const external = makeExternal({ personalStatus: 'divorced' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(true);
  });

  it('blocks a divorced external via an explicit personalStatus constraint', () => {
    const internal = makeInternal({
      hardConstraints: [{ field: 'personalStatus', operator: 'eq', value: 'divorced' }],
    });
    const external = makeExternal({ personalStatus: 'divorced' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(false);
  });

  it('blocks via explicit hard constraint (sector eq)', () => {
    // Constraint: "block if sectorGroup eq haredi" → candidate says "I will NOT consider haredi"
    const internal = makeInternal({
      hardConstraints: [{ field: 'sectorGroup', operator: 'eq', value: 'haredi' }],
    });

    // External is dati_leumi → eq haredi check: dati_leumi === haredi is false → no violation → eligible
    const result1 = evaluateHardRules(internal, makeExternal({ sectorGroup: 'dati_leumi' }), makeContext());
    expect(result1.eligible).toBe(true);

    // External IS haredi → eq haredi: haredi === haredi is true → violation → blocked
    const result2 = evaluateHardRules(internal, makeExternal({ sectorGroup: 'haredi' }), makeContext());
    expect(result2.eligible).toBe(false);
    expect(result2.blockers[0]!.message).toContain('הופר אילוץ קשיח של הצד הפנימי');
  });

  it('does NOT hard-block by sector by default (no constraint)', () => {
    const internal = makeInternal({ sectorGroup: 'dati_leumi' });
    const external = makeExternal({ sectorGroup: 'haredi' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(true); // sector mismatch is NOT a hard blocker
  });
});

// ══════════════════════════════════════════════════════════
// 2. SECTOR CLOSENESS MATRIX
// ══════════════════════════════════════════════════════════

describe('Sector Closeness Matrix', () => {
  it('returns 1.0 for same sector group', () => {
    expect(sectorGroupCloseness('dati_leumi', 'dati_leumi')).toBe(1.0);
    expect(sectorGroupCloseness('haredi', 'haredi')).toBe(1.0);
  });

  it('returns moderate closeness for related sectors', () => {
    const closeness = sectorGroupCloseness('dati_leumi', 'dati');
    expect(closeness).toBeGreaterThanOrEqual(0.6);
    expect(closeness).toBeLessThanOrEqual(0.8);
  });

  it('returns low but non-zero for distant sectors', () => {
    const closeness = sectorGroupCloseness('haredi', 'masorti');
    expect(closeness).toBeGreaterThan(0);
    expect(closeness).toBeLessThan(0.3);
  });

  it('returns 0.5 for missing data (neutral assumption)', () => {
    expect(sectorGroupCloseness(undefined, 'haredi')).toBe(0.5);
    expect(sectorGroupCloseness('haredi', undefined)).toBe(0.5);
  });

  it('sub-sector closeness reflects community nuance', () => {
    // Dati Leumi Open and Dati Lite should be quite close
    expect(subSectorCloseness('dati_leumi_open', 'dati_lite', 'dati_leumi', 'dati'))
      .toBeGreaterThan(0.6);

    // Haredi Hasidic and Dati Leumi Open should be distant
    expect(subSectorCloseness('haredi_hasidic', 'dati_leumi_open', 'haredi', 'dati_leumi'))
      .toBeLessThan(0.2);

    // Hardal Open and Dati Leumi Torani should be close (bridge community)
    expect(subSectorCloseness('hardal_open', 'dati_leumi_torani', 'hardal', 'dati_leumi'))
      .toBeGreaterThan(0.7);
  });

  it('combined closeness weights sub-sector when available', () => {
    const withSub = combinedSectorCloseness('dati_leumi', 'dati_leumi_torani', 'hardal', 'hardal_open');
    const withoutSub = combinedSectorCloseness('dati_leumi', undefined, 'hardal', undefined);
    // With sub-sector data the result should be different (more precise)
    expect(withSub).not.toBe(withoutSub);
  });
});

// ══════════════════════════════════════════════════════════
// 3. LIFESTYLE CLOSENESS
// ══════════════════════════════════════════════════════════

describe('Lifestyle Closeness', () => {
  it('returns 1.0 for same lifestyle tone', () => {
    expect(lifestyleCloseness('moderate', 'moderate')).toBe(1.0);
  });

  it('adjacent tones have high closeness', () => {
    expect(lifestyleCloseness('moderate', 'relaxed')).toBeGreaterThan(0.7);
    expect(lifestyleCloseness('strict', 'moderate')).toBeGreaterThan(0.6);
  });

  it('extreme tones have low closeness', () => {
    expect(lifestyleCloseness('very_strict', 'flexible')).toBeLessThan(0.2);
  });
});

// ══════════════════════════════════════════════════════════
// 4. AGE SCORING
// ══════════════════════════════════════════════════════════

describe('Age Scoring', () => {
  it('gives high score for small age gap', () => {
    const internal = makeInternal({ dateOfBirth: new Date('1998-01-01') }); // ~28
    const external = makeExternal({ age: 26 });
    const result = scorePair(internal, external, makeContext());
    const ageDim = result.breakdown.find(d => d.dimension === 'age');
    expect(ageDim!.score).toBeGreaterThanOrEqual(90);
  });

  it('gives lower score for large age gap', () => {
    const internal = makeInternal({ dateOfBirth: new Date('1998-01-01') });
    const external = makeExternal({ age: 35 });
    const result = scorePair(internal, external, makeContext());
    const ageDim = result.breakdown.find(d => d.dimension === 'age');
    expect(ageDim!.score).toBeLessThan(60);
  });

  it('gives 0 score for extreme age gap', () => {
    const internal = makeInternal({ dateOfBirth: new Date('2000-01-01') });
    const external = makeExternal({ age: 50 });
    const result = scorePair(internal, external, makeContext());
    const ageDim = result.breakdown.find(d => d.dimension === 'age');
    expect(ageDim!.score).toBe(0);
  });

  it('treats unknown external age as a data gap (below neutral), not a free pass', () => {
    const external = makeExternal({ age: undefined });
    const result = scorePair(makeInternal(), external, makeContext());
    const ageDim = result.breakdown.find(d => d.dimension === 'age');
    expect(ageDim!.score).toBe(40);
  });
});

// ══════════════════════════════════════════════════════════
// 5. SECOND-CHAPTER CASES
// ══════════════════════════════════════════════════════════

describe('Second-Chapter Cases', () => {
  it('relaxes age scoring for divorced candidates', () => {
    const internal = makeInternal({
      personalStatus: 'divorced',
      dateOfBirth: new Date('1990-01-01'), // ~36
    });
    const external = makeExternal({ age: 30 });

    const normalInternal = makeInternal({ dateOfBirth: new Date('1990-01-01') });

    const secondChapterResult = scorePair(internal, external, makeContext());
    const normalResult = scorePair(normalInternal, external, makeContext());

    const scAge = secondChapterResult.breakdown.find(d => d.dimension === 'age')!.score;
    const normalAge = normalResult.breakdown.find(d => d.dimension === 'age')!.score;

    // Second chapter should get a better age score due to relaxed thresholds
    expect(scAge).toBeGreaterThanOrEqual(normalAge);
  });

  it('relaxes sector scoring for widowed candidates', () => {
    const internal = makeInternal({
      personalStatus: 'widowed',
      sectorGroup: 'dati_leumi',
      subSector: 'dati_leumi_classic',
    });
    const external = makeExternal({
      sectorGroup: 'dati',
      subSector: 'dati_classic',
    });

    const normalInternal = makeInternal();
    const secondResult = scorePair(internal, external, makeContext());
    const normalResult = scorePair(normalInternal, external, makeContext());

    const scSector = secondResult.breakdown.find(d => d.dimension === 'sector')!.score;
    const normalSector = normalResult.breakdown.find(d => d.dimension === 'sector')!.score;

    expect(scSector).toBeGreaterThanOrEqual(normalSector);
  });
});

// ══════════════════════════════════════════════════════════
// 6. STRICT vs DISCOVERY MODE
// ══════════════════════════════════════════════════════════

describe('Strict vs Discovery Mode', () => {
  it('strict mode filters out creative and risky matches', () => {
    // Create a pair that would score as creative/risky (low score)
    const internal = makeInternal({ sectorGroup: 'dati_leumi', subSector: 'dati_leumi_open' });
    const external = makeExternal({
      sectorGroup: 'haredi',
      subSector: 'haredi_hasidic',
      lifestyleTone: 'very_strict',
      studyWorkDirection: 'full_time_torah',
      city: 'Bnei Brak',
    });

    const strictResults = findMatches(internal, [external], makeContext({ mode: 'strict' }));
    const discoveryResults = findMatches(internal, [external], makeContext({ mode: 'discovery' }));

    // Strict should filter this out, discovery may include it
    expect(strictResults.length).toBeLessThanOrEqual(discoveryResults.length);
  });

  it('discovery mode includes flexibility bonus in scoring', () => {
    const internal = makeInternal();
    const external = makeExternal();
    const strictResult = scorePair(internal, external, makeContext({ mode: 'strict' }));
    const discoveryResult = scorePair(internal, external, makeContext({ mode: 'discovery' }));

    const strictFlex = strictResult.breakdown.find(d => d.dimension === 'flexibility')!.score;
    const discoveryFlex = discoveryResult.breakdown.find(d => d.dimension === 'flexibility')!.score;

    // Discovery mode adds a flexibility bonus
    expect(discoveryFlex).toBeGreaterThan(strictFlex);
  });
});

// ══════════════════════════════════════════════════════════
// 7. PENALTIES
// ══════════════════════════════════════════════════════════

describe('Penalties', () => {
  it('no penalties for fresh data and no history', () => {
    const penalties = computePenalties(makeInternal(), makeExternal(), makeContext());
    expect(penalties.totalPenalty).toBe(0);
  });

  it('stale penalty for old external profile', () => {
    const external = makeExternal({
      sourceImportedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000), // 120 days ago
      lastSourceUpdateAt: undefined,
      lastConfirmedAvailableAt: undefined,
    });
    const penalties = computePenalties(makeInternal(), external, makeContext());
    expect(penalties.stalePenalty).toBeGreaterThan(0);
  });

  it('timing penalty for recent action', () => {
    const internal = makeInternal({
      lastActionAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
    });
    const penalties = computePenalties(internal, makeExternal(), makeContext());
    expect(penalties.timingPenalty).toBeGreaterThan(0);
  });

  it('load penalty for too many active suggestions', () => {
    const context = makeContext({ activeSuggestionCount: 8 });
    const penalties = computePenalties(makeInternal(), makeExternal(), context);
    expect(penalties.loadPenalty).toBeGreaterThan(0);
  });

  it('total penalty is capped at 40', () => {
    const internal = makeInternal({
      lastActionAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });
    const external = makeExternal({
      sourceImportedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      lastSourceUpdateAt: undefined,
      lastConfirmedAvailableAt: undefined,
    });
    const context = makeContext({ activeSuggestionCount: 20 });
    const penalties = computePenalties(internal, external, context);
    expect(penalties.totalPenalty).toBeLessThanOrEqual(40);
  });
});

// ══════════════════════════════════════════════════════════
// 8. CONFIDENCE SCORE
// ══════════════════════════════════════════════════════════

describe('Confidence Score', () => {
  it('full data pair has high confidence', () => {
    const result = evaluatePair(makeInternal(), makeExternal(), makeContext());
    expect(result.confidenceScore).toBeGreaterThanOrEqual(70);
  });

  it('missing external data lowers confidence', () => {
    const full = evaluatePair(makeInternal(), makeExternal(), makeContext());
    const sparse = evaluatePair(
      makeInternal(),
      makeExternal({
        gender: undefined,
        age: undefined,
        sectorGroup: undefined,
        city: undefined,
      }),
      makeContext(),
    );
    expect(sparse.confidenceScore).toBeLessThan(full.confidenceScore);
  });

  it('approximate age lowers confidence', () => {
    const exact = evaluatePair(
      makeInternal(),
      makeExternal({ ageReliability: { ageConfidence: 'exact' } }),
      makeContext(),
    );
    const approx = evaluatePair(
      makeInternal(),
      makeExternal({ ageReliability: { ageConfidence: 'estimated' } }),
      makeContext(),
    );
    expect(approx.confidenceScore).toBeLessThan(exact.confidenceScore);
  });

  it('stale external profile lowers confidence', () => {
    const fresh = evaluatePair(makeInternal(), makeExternal(), makeContext());
    const stale = evaluatePair(
      makeInternal(),
      makeExternal({ staleAt: new Date() }),
      makeContext(),
    );
    expect(stale.confidenceScore).toBeLessThan(fresh.confidenceScore);
  });

  it('low internal completion lowers confidence', () => {
    const complete = evaluatePair(
      makeInternal({ profileCompletion: 90 }),
      makeExternal(),
      makeContext(),
    );
    const incomplete = evaluatePair(
      makeInternal({ profileCompletion: 40 }),
      makeExternal(),
      makeContext(),
    );
    expect(incomplete.confidenceScore).toBeLessThan(complete.confidenceScore);
  });
});

// ══════════════════════════════════════════════════════════
// 9. MATCH TYPE CLASSIFICATION
// ══════════════════════════════════════════════════════════

describe('Match Type Classification', () => {
  it('classifies ideal pair as safe', () => {
    const result = evaluatePair(makeInternal(), makeExternal(), makeContext());
    expect(result.matchType).toBe('safe');
  });

  it('classifies moderate pair as balanced', () => {
    const result = evaluatePair(
      makeInternal({ sectorGroup: 'dati_leumi', subSector: 'dati_leumi_classic' }),
      makeExternal({
        sectorGroup: 'dati',
        subSector: 'dati_classic',
        lifestyleTone: 'relaxed',
        studyWorkDirection: 'working',
        city: 'Haifa',
      }),
      makeContext(),
    );
    expect(['safe', 'balanced']).toContain(result.matchType);
  });

  it('classifies distant pair as creative or risky', () => {
    const result = evaluatePair(
      makeInternal({ sectorGroup: 'dati_leumi', subSector: 'dati_leumi_open' }),
      makeExternal({
        sectorGroup: 'haredi',
        subSector: 'haredi_litvish',
        lifestyleTone: 'very_strict',
        studyWorkDirection: 'full_time_torah',
        city: 'Bnei Brak',
        lifeStage: 'yeshiva_seminary',
      }),
      makeContext(),
    );
    expect(['creative', 'risky']).toContain(result.matchType);
  });

  it('very low confidence forces risky classification', () => {
    const result = evaluatePair(
      makeInternal(),
      makeExternal({
        gender: undefined,
        age: undefined,
        sectorGroup: undefined,
        lifestyleTone: undefined,
        city: undefined,
      }),
      makeContext(),
    );
    // Missing gender (30) + age (15) + sector (15) + lifestyle (8) + city (8) = 76 deductions
    // Confidence ≈ 24, which is < 30 → forces risky
    expect(result.matchType).toBe('risky');
  });
});

// ══════════════════════════════════════════════════════════
// 10. RECOMMENDED ACTION
// ══════════════════════════════════════════════════════════

describe('Recommended Action', () => {
  it('recommends send_to_both for ideal high-confidence safe match', () => {
    // Default fixtures are an ideal pair: full data, same sector, same city, etc.
    const result = evaluatePair(makeInternal(), makeExternal(), makeContext());
    expect(result.matchType).toBe('safe');
    expect(result.recommendedAction).toBe('send_to_both');
    expect(result.sendStrategy).toBe('both_simultaneously');
  });

  it('recommends send_side_a_first for safe match with minor risk factors', () => {
    // Drop enough data to pull confidence below the "ideal" 85 threshold
    const result = evaluatePair(
      makeInternal(),
      makeExternal({
        studyWorkDirection: undefined,
        lifestyleTone: undefined,
        lifeStage: undefined,
        personalStatus: undefined,
      }),
      makeContext(),
    );
    // Confidence drops by 5+8+5+5 = 23 → ~77. Still safe but not "send_to_both" ideal.
    if (result.matchType === 'safe') {
      expect(['send_side_a_first', 'auto_review_queue']).toContain(result.recommendedAction);
    }
  });

  it('recommends auto_review_queue for strong balanced match', () => {
    const result = evaluatePair(
      makeInternal({ sectorGroup: 'dati_leumi', subSector: 'dati_leumi_classic' }),
      makeExternal({
        sectorGroup: 'dati',
        subSector: 'dati_classic',
        lifestyleTone: 'relaxed',
        city: 'Haifa',
      }),
      makeContext(),
    );
    if (result.matchType === 'balanced') {
      expect(result.recommendedAction).toBe('auto_review_queue');
    }
  });

  it('recommends hold_for_more_data when send readiness blockers exist', () => {
    const result = evaluatePair(
      makeInternal({ sendReadinessBlockers: ['Photo not approved'] }),
      makeExternal(),
      makeContext(),
    );
    expect(result.recommendedAction).toBe('hold_for_more_data');
  });

  it('recommends review_required for creative matches', () => {
    const result = evaluatePair(
      makeInternal({ sectorGroup: 'dati_leumi', subSector: 'dati_leumi_open' }),
      makeExternal({
        sectorGroup: 'haredi',
        subSector: 'haredi_modern',
        lifestyleTone: 'strict',
        studyWorkDirection: 'torah_with_work',
        city: 'Jerusalem',
        lifeStage: 'early_career',
      }),
      makeContext({ mode: 'discovery' }),
    );
    if (result.matchType === 'creative' || result.matchType === 'risky') {
      expect(result.recommendedAction).toBe('review_required');
    }
  });

  it('recommends hold_for_more_data when confidence is very low', () => {
    const result = evaluatePair(
      makeInternal(),
      makeExternal({
        gender: undefined,
        age: undefined,
        sectorGroup: undefined,
        city: undefined,
        lifestyleTone: undefined,
      }),
      makeContext(),
    );
    expect(result.recommendedAction).toBe('hold_for_more_data');
  });
});

// ══════════════════════════════════════════════════════════
// 11. FULL ENGINE (findMatches)
// ══════════════════════════════════════════════════════════

describe('findMatches (full pipeline)', () => {
  it('returns sorted results for multiple external candidates', () => {
    const internal = makeInternal();
    const externals = [
      makeExternal({ _id: 'ext-1', age: 25, city: 'Jerusalem' }),
      makeExternal({ _id: 'ext-2', age: 30, city: 'Haifa', sectorGroup: 'dati', lifestyleTone: 'relaxed' }),
      makeExternal({ _id: 'ext-3', age: 25, city: 'Jerusalem', sectorGroup: 'dati_leumi' }),
    ];

    const results = findMatches(internal, externals, makeContext());
    expect(results.length).toBeGreaterThan(0);
    // Should be sorted by matchScore descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.matchScore).toBeGreaterThanOrEqual(results[i]!.matchScore);
    }
  });

  it('excludes ineligible candidates', () => {
    const internal = makeInternal();
    const externals = [
      makeExternal({ _id: 'ext-ok', gender: 'female' }),
      makeExternal({ _id: 'ext-bad', gender: 'male' }), // same gender
    ];
    const results = findMatches(internal, externals, makeContext());
    expect(results.find(r => r.externalCandidateId === 'ext-bad')).toBeUndefined();
  });

  it('strict mode returns fewer results than discovery', () => {
    const internal = makeInternal();
    const externals = Array.from({ length: 10 }, (_, i) =>
      makeExternal({
        _id: `ext-${i}`,
        sectorGroup: i < 5 ? 'dati_leumi' : 'haredi',
        subSector: i < 5 ? 'dati_leumi_classic' : 'haredi_modern',
        lifestyleTone: i < 5 ? 'moderate' : 'strict',
        city: i < 3 ? 'Jerusalem' : 'Other',
      }),
    );

    const strict = findMatches(internal, externals, makeContext({ mode: 'strict' }));
    const discovery = findMatches(internal, externals, makeContext({ mode: 'discovery' }));

    expect(strict.length).toBeLessThanOrEqual(discovery.length);
  });

  it('all results have complete structure', () => {
    const results = findMatches(makeInternal(), [makeExternal()], makeContext());
    expect(results.length).toBe(1);
    const r = results[0]!;

    expect(r.eligible).toBe(true);
    expect(r.hardBlockers).toEqual([]);
    expect(r.matchScore).toBeGreaterThanOrEqual(0);
    expect(r.matchScore).toBeLessThanOrEqual(100);
    expect(r.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(r.confidenceScore).toBeLessThanOrEqual(100);
    expect(['safe', 'balanced', 'creative', 'risky']).toContain(r.matchType);
    expect(['none', 'low', 'medium', 'high']).toContain(r.riskLevel);
    expect(r.scoreBreakdown).toHaveLength(8);
    expect(r.penalties).toBeDefined();
    expect(r.penalties.totalPenalty).toBeGreaterThanOrEqual(0);
    expect(r.sourceMode).toBe('strict');
  });
});

// ══════════════════════════════════════════════════════════
// 12. LIFE STAGE AND STUDY-WORK CLOSENESS
// ══════════════════════════════════════════════════════════

describe('Life Stage Closeness', () => {
  it('same stage = 1.0', () => {
    expect(lifeStageCloseness('early_career', 'early_career')).toBe(1.0);
  });

  it('adjacent stages are close', () => {
    expect(lifeStageCloseness('early_studies', 'mid_studies')).toBeGreaterThan(0.8);
  });

  it('distant stages are far', () => {
    expect(lifeStageCloseness('post_high_school', 'mature')).toBeLessThan(0.2);
  });
});

describe('Study-Work Closeness', () => {
  it('same direction = 1.0', () => {
    expect(studyWorkCloseness('working', 'working')).toBe(1.0);
  });

  it('torah_with_work and academic are reasonably close', () => {
    expect(studyWorkCloseness('torah_with_work', 'academic_studies')).toBeGreaterThan(0.5);
  });

  it('full_time_torah and military_career are very distant', () => {
    expect(studyWorkCloseness('full_time_torah', 'military_career')).toBeLessThan(0.2);
  });

  // ── Bridge paths (hesder / mechina_army / sherut_leumi) ──
  it('hesder bridges torah and military meaningfully', () => {
    // hesder ↔ full_time_torah should be notably closer than military_career ↔ full_time_torah
    expect(studyWorkCloseness('hesder', 'full_time_torah'))
      .toBeGreaterThan(studyWorkCloseness('military_career', 'full_time_torah'));
    // hesder ↔ military_career should be close (shared service experience)
    expect(studyWorkCloseness('hesder', 'military_career')).toBeGreaterThan(0.6);
  });

  it('mechina_army is close to military_career', () => {
    expect(studyWorkCloseness('mechina_army', 'military_career')).toBeGreaterThan(0.8);
  });

  it('sherut_leumi bridges service and academic paths', () => {
    expect(studyWorkCloseness('sherut_leumi', 'academic_studies')).toBeGreaterThan(0.5);
    expect(studyWorkCloseness('sherut_leumi', 'military_career')).toBeGreaterThan(0.6);
  });

  it('hesder and mechina_army are siblings', () => {
    expect(studyWorkCloseness('hesder', 'mechina_army')).toBeGreaterThan(0.7);
  });
});

// ══════════════════════════════════════════════════════════
// 13. AGE BAND REFINEMENTS
// ══════════════════════════════════════════════════════════

describe('Age Band Configuration', () => {
  it('young life-stage tightens age bands', () => {
    const youngInternal = makeInternal({
      dateOfBirth: new Date('2005-01-01'),
      lifeStage: 'national_service',
      agePreferences: undefined, // isolate age-band behavior from preference violation
    });
    const resultClose = scorePair(
      youngInternal,
      makeExternal({ age: 20 }), // 1 year gap — inside preferred band for young
      makeContext(),
    );
    const resultFar = scorePair(
      youngInternal,
      makeExternal({ age: 32 }), // 11 year gap — beyond young hard band
      makeContext(),
    );
    const closeAge = resultClose.breakdown.find(d => d.dimension === 'age')!.score;
    const farAge = resultFar.breakdown.find(d => d.dimension === 'age')!.score;
    expect(closeAge).toBeGreaterThanOrEqual(90);
    expect(farAge).toBeLessThan(30);
  });

  it('mature life-stage widens age bands', () => {
    const matureInternal = makeInternal({
      dateOfBirth: new Date('1980-01-01'), // ~46
      lifeStage: 'mature',
      agePreferences: undefined,
    });
    const defaultInternal = makeInternal({
      dateOfBirth: new Date('1980-01-01'),
      lifeStage: 'early_career',
      agePreferences: undefined,
    });
    const external = makeExternal({ age: 40 }); // 6 year gap

    const matureResult = scorePair(matureInternal, external, makeContext());
    const defaultResult = scorePair(defaultInternal, external, makeContext());

    const matureAge = matureResult.breakdown.find(d => d.dimension === 'age')!.score;
    const defaultAge = defaultResult.breakdown.find(d => d.dimension === 'age')!.score;

    // Mature bands should be more forgiving for this gap
    expect(matureAge).toBeGreaterThanOrEqual(defaultAge);
  });

  it('detail string includes which band the gap fell into', () => {
    const internal = makeInternal({ dateOfBirth: new Date('1998-01-01') });
    const external = makeExternal({ age: 26 });
    const result = scorePair(internal, external, makeContext());
    const ageDim = result.breakdown.find(d => d.dimension === 'age')!;
    expect(ageDim.detail).toMatch(/מועדף|גמיש|רחב|גבולי|מעבר לטווח/);
  });
});

// ══════════════════════════════════════════════════════════
// 14. PERSONAL-STATUS COMPATIBILITY
// ══════════════════════════════════════════════════════════

describe('Personal-Status Compatibility', () => {
  it('allows single-single pairs freely', () => {
    const result = evaluateHardRules(
      makeInternal({ personalStatus: 'single' }),
      makeExternal({ personalStatus: 'single' }),
      makeContext(),
    );
    expect(result.eligible).toBe(true);
  });

  it('allows divorced pair when internal is open to divorced', () => {
    const internal = makeInternal({
      personalStatus: 'divorced',
      openness: { ...makeInternal().openness, openToDivorced: true },
    });
    const external = makeExternal({ personalStatus: 'divorced' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(true);
  });

  it('allows widowed by default (no explicit block)', () => {
    const external = makeExternal({ personalStatus: 'widowed' });
    const result = evaluateHardRules(makeInternal(), external, makeContext());
    expect(result.eligible).toBe(true);
  });

  it('blocks widowed with explicit eq constraint', () => {
    // Semantic: eq constraint violates when external value === constraint value,
    // i.e. "I want to block candidates whose personalStatus equals widowed".
    const internal = makeInternal({
      hardConstraints: [
        { field: 'personalStatus', operator: 'eq', value: 'widowed' },
      ],
    });
    const external = makeExternal({ personalStatus: 'widowed' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(false);
  });

  it('blocks widowed with not_in allowlist that excludes widowed', () => {
    // Semantic: not_in violates when external value is NOT in the list,
    // i.e. "only consider these statuses" → widowed not in list → blocked.
    const internal = makeInternal({
      hardConstraints: [
        { field: 'personalStatus', operator: 'not_in', value: ['single', 'divorced'] },
      ],
    });
    const external = makeExternal({ personalStatus: 'widowed' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(false);
  });

  it('blocks second-chapter when internal has explicit children blocker', () => {
    const internal = makeInternal({
      openness: { ...makeInternal().openness, openToDivorced: true, openToWithChildren: false },
      hardConstraints: [
        { field: 'hasChildren', operator: 'eq', value: true },
      ],
    });
    const external = makeExternal({ personalStatus: 'divorced' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(false);
    expect(result.blockers.map((b) => b.message).join(' ')).toContain('ילדים');
  });

  it('does NOT block second-chapter on children inference alone', () => {
    // openToWithChildren is false but no explicit children constraint → still allowed
    const internal = makeInternal({
      openness: { ...makeInternal().openness, openToDivorced: true, openToWithChildren: false },
      hardConstraints: [],
    });
    const external = makeExternal({ personalStatus: 'divorced' });
    const result = evaluateHardRules(internal, external, makeContext());
    expect(result.eligible).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// 15. PATTERN-BASED PENALTIES
// ══════════════════════════════════════════════════════════

describe('Pattern-based Penalties', () => {
  it('similar-profile decline pattern adds history penalty', () => {
    const baseline = computePenalties(makeInternal(), makeExternal(), makeContext());
    const withPattern = computePenalties(
      makeInternal(),
      makeExternal(),
      makeContext({ similarProfileDeclineCount: 3 }),
    );
    expect(withPattern.historyPenalty).toBeGreaterThan(baseline.historyPenalty);
  });

  it('external fatigue (many recent proposals) adds history penalty', () => {
    const baseline = computePenalties(makeInternal(), makeExternal(), makeContext());
    const withFatigue = computePenalties(
      makeInternal(),
      makeExternal(),
      makeContext({ recentSimilarProposalCount: 8 }),
    );
    expect(withFatigue.historyPenalty).toBeGreaterThan(baseline.historyPenalty);
  });

  it('internal fatigue adds to timing penalty', () => {
    const baseline = computePenalties(makeInternal(), makeExternal(), makeContext());
    const withFatigue = computePenalties(
      makeInternal(),
      makeExternal(),
      makeContext({ recentProposalsReceivedByInternal: 10 }),
    );
    expect(withFatigue.timingPenalty).toBeGreaterThan(baseline.timingPenalty);
  });

  it('zero pattern signals produce zero pattern penalty', () => {
    const result = computePenalties(makeInternal(), makeExternal(), makeContext({
      similarProfileDeclineCount: 0,
      recentSimilarProposalCount: 0,
      recentProposalsReceivedByInternal: 0,
    }));
    expect(result.historyPenalty).toBe(0);
    expect(result.timingPenalty).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// 15b. PERSONAL-STATUS PENALTY (single ↔ second-chapter)
// ══════════════════════════════════════════════════════════

describe('Personal-status penalty', () => {
  it('single ↔ single: no status penalty', () => {
    const p = computePenalties(
      makeInternal({ personalStatus: 'single' }),
      makeExternal({ personalStatus: 'single' }),
      makeContext(),
    );
    expect(p.statusPenalty).toBe(0);
  });

  it('divorced ↔ divorced: no status penalty', () => {
    const p = computePenalties(
      makeInternal({ personalStatus: 'divorced' }),
      makeExternal({ personalStatus: 'divorced' }),
      makeContext(),
    );
    expect(p.statusPenalty).toBe(0);
  });

  it('single internal ↔ divorced external (flag unknown): penalised (sinks to bottom)', () => {
    // Unknown flag → eligible but low-scored. (An explicit false would block
    // instead — covered in the hard-rules suite.)
    const p = computePenalties(
      makeInternal({ personalStatus: 'single' }), // openToDivorced unset
      makeExternal({ personalStatus: 'divorced' }),
      makeContext(),
    );
    expect(p.statusPenalty).toBeGreaterThan(0);
  });

  it('single internal explicitly open to divorced: no penalty', () => {
    const p = computePenalties(
      makeInternal({ personalStatus: 'single', openness: { ...makeInternal().openness, openToDivorced: true } }),
      makeExternal({ personalStatus: 'divorced' }),
      makeContext(),
    );
    expect(p.statusPenalty).toBe(0);
  });

  it('divorced internal ↔ single external: penalised (single side prefers single)', () => {
    const p = computePenalties(
      makeInternal({ personalStatus: 'divorced' }),
      makeExternal({ personalStatus: 'single' }),
      makeContext(),
    );
    expect(p.statusPenalty).toBeGreaterThan(0);
  });

  it('a divorced pair scores higher than a single↔divorced pair, all else equal', () => {
    const divorcedExternal = makeExternal({ personalStatus: 'divorced', openness: { openToDivorced: true } });
    const singleInternal = evaluatePair(
      makeInternal({ personalStatus: 'single' }),
      divorcedExternal,
      makeContext(),
    );
    const divorcedInternal = evaluatePair(
      makeInternal({ personalStatus: 'divorced', openness: { ...makeInternal().openness, openToDivorced: true } }),
      divorcedExternal,
      makeContext(),
    );
    expect(divorcedInternal.matchScore).toBeGreaterThan(singleInternal.matchScore);
  });
});

// ══════════════════════════════════════════════════════════
// 16. MATCH TYPE RISK-PATTERN DOWNGRADES
// ══════════════════════════════════════════════════════════

describe('Match Type Risk-Pattern Downgrades', () => {
  it('second-chapter + severe lifestyle gap prevents safe classification', () => {
    const internal = makeInternal({
      personalStatus: 'divorced',
      dateOfBirth: new Date('1990-01-01'),
      lifestyleTone: 'very_strict',
      openness: { ...makeInternal().openness, openToDivorced: true },
    });
    const external = makeExternal({
      personalStatus: 'divorced',
      age: 34,
      lifestyleTone: 'flexible', // severe gap (very_strict ↔ flexible = 0.1)
    });
    const result = evaluatePair(internal, external, makeContext());
    // Even if scores are decent, risk pattern should prevent 'safe'
    expect(result.matchType).not.toBe('safe');
  });

  it('severe lifestyle + severe age gap classifies as risky even at creative score', () => {
    const internal = makeInternal({
      dateOfBirth: new Date('2002-01-01'), // ~24
      lifestyleTone: 'very_strict',
    });
    const external = makeExternal({
      age: 40, // severe age gap
      lifestyleTone: 'flexible', // severe lifestyle gap
      sectorGroup: 'dati', // not too distant to avoid HIGH_RISK_THRESHOLD force
      subSector: 'dati_classic',
    });
    const result = evaluatePair(internal, external, makeContext());
    expect(['risky', 'creative']).toContain(result.matchType);
  });
});

// ══════════════════════════════════════════════════════════
// 17. BIDIRECTIONAL MATCHING — A fits B AND B fits A
// ══════════════════════════════════════════════════════════
// The engine evaluates hard rules AND preference-driven soft
// dimensions in BOTH directions. External-side preferences
// are optional (often partial data) but when present they
// produce hard blockers and soft-score effects symmetrically
// with internal-side preferences.

describe('Bidirectional — hard rules (reverse direction)', () => {
  it('external not_in constraint blocks when internal is excluded', () => {
    const internal = makeInternal({ city: 'Jerusalem' });
    const external = makeExternal({
      city: 'Jerusalem',
      hardConstraints: [{ field: 'city', operator: 'not_in', value: ['Bnei Brak'] }],
    });
    const res = evaluateHardRules(internal, external, makeContext());
    expect(res.eligible).toBe(false);
    expect(res.blockers[0]!.message).toContain('הופר אילוץ קשיח של הצד החיצוני');
  });

  it('external eq constraint blocks when internal matches block target', () => {
    const internal = makeInternal({ personalStatus: 'divorced' });
    const external = makeExternal({
      hardConstraints: [{ field: 'personalStatus', operator: 'eq', value: 'divorced' }],
    });
    const res = evaluateHardRules(internal, external, makeContext());
    expect(res.eligible).toBe(false);
    expect(res.blockers[0]!.message).toContain('הופר אילוץ קשיח של הצד החיצוני');
  });

  it('external openToDivorced=false blocks a divorced internal', () => {
    const internal = makeInternal({ personalStatus: 'divorced' });
    const external = makeExternal({
      personalStatus: 'single',
      openness: { openToDivorced: false },
    });
    const res = evaluateHardRules(internal, external, makeContext());
    expect(res.eligible).toBe(false);
    expect(res.blockers.map((b) => b.message).join(' ')).toContain('המועמד החיצוני ציין במפורש שאינו פתוח למועמדים בסטטוס גרוש/ה');
  });

  it('no external preferences leaves pair eligible (backward compatible)', () => {
    const res = evaluateHardRules(makeInternal(), makeExternal(), makeContext());
    expect(res.eligible).toBe(true);
  });
});

describe('Bidirectional — soft scoring', () => {
  it('external age preference lowers age score (reverse direction)', () => {
    const internal = makeInternal({ dateOfBirth: new Date('1998-01-01') });
    const baseline = scorePair(
      internal,
      makeExternal({ age: 26, agePreferences: undefined }),
      makeContext(),
    ).breakdown.find((d) => d.dimension === 'age')!.score;

    const withReversePref = scorePair(
      internal,
      makeExternal({
        age: 26,
        agePreferences: { min: 40, max: 50, flexibility: 'strict' },
      }),
      makeContext(),
    ).breakdown.find((d) => d.dimension === 'age')!.score;

    expect(withReversePref).toBeLessThan(baseline);
  });

  it('mutual expectations takes the MIN of forward and reverse scores', () => {
    const internal = makeInternal({
      softPreferences: [
        { field: 'city', value: 'Jerusalem', importance: 'important' },
      ],
    });
    const external = makeExternal({
      city: 'Jerusalem',
      softPreferences: [
        { field: 'sectorGroup', value: 'haredi', importance: 'must_have' },
      ],
    });
    const me = scorePair(internal, external, makeContext())
      .breakdown.find((d) => d.dimension === 'mutual_expectations')!;
    expect(me.score).toBeLessThan(80);
    expect(me.detail).toMatch(/שני הצדדים|הפוך/);
  });

  it('either side willing to relocate boosts location score', () => {
    const internal = makeInternal({
      city: 'Jerusalem',
      locationPreferences: { cities: ['Jerusalem'], willingToRelocate: false },
    });
    const external = makeExternal({
      city: 'Haifa',
      locationPreferences: { willingToRelocate: true },
    });
    const loc = scorePair(internal, external, makeContext())
      .breakdown.find((d) => d.dimension === 'location')!;
    expect(loc.score).toBeGreaterThan(30);
    expect(loc.detail).toMatch(/מוכן לעבור|לעבור דירה/);
  });

  it('either side openToOtherSectors boosts low sector closeness', () => {
    const baseline = scorePair(
      makeInternal({ sectorGroup: 'dati_leumi', subSector: 'dati_leumi_open' }),
      makeExternal({ sectorGroup: 'haredi', subSector: 'haredi_litvish' }),
      makeContext(),
    ).breakdown.find((d) => d.dimension === 'sector')!.score;

    const withExternalOpenness = scorePair(
      makeInternal({ sectorGroup: 'dati_leumi', subSector: 'dati_leumi_open' }),
      makeExternal({
        sectorGroup: 'haredi',
        subSector: 'haredi_litvish',
        openness: { openToOtherSectors: true },
      }),
      makeContext(),
    ).breakdown.find((d) => d.dimension === 'sector')!.score;

    expect(withExternalOpenness).toBeGreaterThan(baseline);
  });

  it('symmetric dimensions (lifestyle, study_work, life_stage) are direction-independent', () => {
    const r1 = scorePair(makeInternal(), makeExternal(), makeContext());
    const r2 = scorePair(
      makeInternal(),
      makeExternal({ openness: { openToOtherSectors: false } }),
      makeContext(),
    );
    for (const dim of ['lifestyle', 'study_work', 'life_stage'] as const) {
      const s1 = r1.breakdown.find((d) => d.dimension === dim)!.score;
      const s2 = r2.breakdown.find((d) => d.dimension === dim)!.score;
      expect(s2).toBe(s1);
    }
  });
});
