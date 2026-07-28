import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

const executeWithFallback = vi.fn();
vi.mock('../../services/ai/ai.service.js', () => ({
  executeWithFallback: (...a: unknown[]) => executeWithFallback(...a),
}));

const getSettingCached = vi.fn();
vi.mock('../settings/settings.service.js', () => ({
  getSettingCached: (...a: unknown[]) => getSettingCached(...a),
}));

const internalFindById = vi.fn();
const externalFind = vi.fn();
vi.mock('../../models/index.js', () => ({
  InternalCandidate: { findById: (...a: unknown[]) => internalFindById(...a) },
  ExternalCandidate: { find: (...a: unknown[]) => externalFind(...a) },
}));

const sessionUpdateOne = vi.fn();
vi.mock('./discovery-session.model.js', () => ({
  DiscoverySession: { updateOne: (...a: unknown[]) => sessionUpdateOne(...a) },
}));

import { maybeRefineSession, generateWizard } from './discovery-ai.service.js';
import type { IDiscoverySession } from './discovery-session.model.js';

const INTERNAL_ID = '507f1f77bcf86cd799439011';

function makeSession(over: Partial<IDiscoverySession> = {}): IDiscoverySession {
  return {
    _id: new Types.ObjectId(),
    internalCandidateId: new Types.ObjectId(INTERNAL_ID),
    status: 'active',
    cards: [],
    aiSummaries: [],
    currentBatchIndex: 1,
    counters: { served: 5, liked: 2, rejected: 3, skipped: 0, aiCalls: 0 },
    ...over,
  } as unknown as IDiscoverySession;
}

function decidedCard(verdict: 'like' | 'reject', batchIndex = 1) {
  return {
    cardId: 'c', externalCandidateId: new Types.ObjectId(), batchIndex,
    servedAt: new Date(), engineScore: 70, hasPhoto: false, verdict,
  };
}

function stubSettings(map: Record<string, unknown>) {
  getSettingCached.mockImplementation(async (key: string) => map[key]);
}

function stubExternals(rows: unknown[] = []) {
  externalFind.mockReturnValue({
    select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(rows) }) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionUpdateOne.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });
});

describe('maybeRefineSession — graceful degradation', () => {
  it('skips silently when the refine toggle is off', async () => {
    stubSettings({ 'discovery.ai_refine_enabled': false });
    const session = makeSession({ cards: [decidedCard('like'), decidedCard('reject'), decidedCard('reject')] });
    await maybeRefineSession(session);
    expect(executeWithFallback).not.toHaveBeenCalled();
  });

  it('respects the per-session AI call cap', async () => {
    stubSettings({ 'discovery.ai_refine_enabled': true, 'discovery.max_ai_calls_per_session': 2 });
    const session = makeSession({
      counters: { served: 5, liked: 2, rejected: 3, skipped: 0, aiCalls: 2 },
      cards: [decidedCard('like'), decidedCard('reject'), decidedCard('reject')],
    });
    await maybeRefineSession(session);
    expect(executeWithFallback).not.toHaveBeenCalled();
  });

  it('skips when fewer than 3 new verdicts landed since the last summary', async () => {
    stubSettings({ 'discovery.ai_refine_enabled': true, 'discovery.max_ai_calls_per_session': 5 });
    const session = makeSession({ cards: [decidedCard('like'), decidedCard('reject')] });
    await maybeRefineSession(session);
    expect(executeWithFallback).not.toHaveBeenCalled();
  });

  it('absorbs a provider/budget failure — session continues, no counters move', async () => {
    stubSettings({ 'discovery.ai_refine_enabled': true, 'discovery.max_ai_calls_per_session': 5 });
    stubExternals();
    executeWithFallback.mockRejectedValue(new Error('ai_budget_exhausted'));
    const session = makeSession({ cards: [decidedCard('like'), decidedCard('reject'), decidedCard('reject')] });

    await expect(maybeRefineSession(session)).resolves.toBeUndefined();
    expect(session.counters.aiCalls).toBe(0);
    expect(session.aiSummaries).toHaveLength(0);
  });

  it('on success persists the summary, bumps aiCalls, and syncs the in-memory doc', async () => {
    stubSettings({ 'discovery.ai_refine_enabled': true, 'discovery.max_ai_calls_per_session': 5 });
    stubExternals();
    executeWithFallback.mockResolvedValue({
      data: {
        summary: 'מחפש בית של תורה',
        positiveSignals: ['תורני'],
        negativeSignals: [],
        avoidFilters: [{ field: 'personalStatus', value: 'divorced' }],
        confidence: 0.7,
      },
      metadata: { model: 'test-model' },
    });
    const session = makeSession({ cards: [decidedCard('like'), decidedCard('reject'), decidedCard('reject')] });

    await maybeRefineSession(session);

    expect(session.counters.aiCalls).toBe(1);
    expect(session.aiSummaries).toHaveLength(1);
    expect(session.aiSummaries[0]).toMatchObject({ summary: 'מחפש בית של תורה', model: 'test-model' });
    // Persisted too — $push + $inc in one atomic update.
    const update = sessionUpdateOne.mock.calls[0]![1] as Record<string, unknown>;
    expect(update['$inc']).toEqual({ 'counters.aiCalls': 1 });
    expect(update['$push']).toBeDefined();
  });
});

describe('generateWizard — AI with static fallback', () => {
  function stubInternal(doc: unknown) {
    internalFindById.mockReturnValue({
      select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(doc) }) }),
    });
  }
  const INTERNAL_DOC = {
    firstName: 'א', gender: 'male', agePreferences: { min: 22, max: 30 },
    about: 'חשוב לי בית של תורה', whatSeeking: '', softPreferences: [],
    sectorGroup: 'haredi', lifestyleTone: 'strict',
  };

  it('falls back to the static wizard when the AI toggle is off', async () => {
    stubInternal(INTERNAL_DOC);
    stubSettings({ 'discovery.ai_wizard_enabled': false, 'discovery.max_ai_calls_per_session': 5 });
    const wizard = await generateWizard(makeSession());
    expect(wizard.source).toBe('static');
    expect(executeWithFallback).not.toHaveBeenCalled();
  });

  it('falls back to static when the AI emits an off-vocabulary question', async () => {
    stubInternal(INTERNAL_DOC);
    stubSettings({ 'discovery.ai_wizard_enabled': true, 'discovery.max_ai_calls_per_session': 5 });
    executeWithFallback.mockResolvedValue({
      data: {
        questions: [
          { id: 'q1', question: 'שאלה', type: 'multi', mapsTo: 'soft:lifestyleTone', options: [{ value: 'moderate', label: 'ממוצע' }] },
          // Off-vocab value → the WHOLE ai wizard is rejected.
          { id: 'q2', question: 'שאלה', type: 'multi', mapsTo: 'soft:lifestyleTone', options: [{ value: 'party_animal', label: 'x' }] },
          { id: 'q3', question: 'גיל', type: 'range', mapsTo: 'ageRange', options: [] },
        ],
      },
      metadata: { model: 'test-model' },
    });

    const wizard = await generateWizard(makeSession());
    expect(wizard.source).toBe('static');
  });

  it('falls back to static when the AI call throws', async () => {
    stubInternal(INTERNAL_DOC);
    stubSettings({ 'discovery.ai_wizard_enabled': true, 'discovery.max_ai_calls_per_session': 5 });
    executeWithFallback.mockRejectedValue(new Error('provider_down'));
    const wizard = await generateWizard(makeSession());
    expect(wizard.source).toBe('static');
  });

  it('returns the AI wizard when every question passes vocabulary validation', async () => {
    stubInternal(INTERNAL_DOC);
    stubSettings({ 'discovery.ai_wizard_enabled': true, 'discovery.max_ai_calls_per_session': 5 });
    executeWithFallback.mockResolvedValue({
      data: {
        questions: [
          { id: 'age', question: 'איזה גיל?', type: 'range', mapsTo: 'ageRange', options: [{ value: '22', label: 'מ' }, { value: '30', label: 'עד' }] },
          { id: 'life', question: 'איזה סגנון?', type: 'multi', mapsTo: 'soft:lifestyleTone', options: [{ value: 'strict', label: 'מחמיר' }] },
          { id: 'open', question: 'גרושה?', type: 'single', mapsTo: 'openness.openToDivorced', options: [{ value: 'yes', label: 'כן' }, { value: 'no', label: 'לא' }] },
        ],
      },
      metadata: { model: 'test-model' },
    });

    const session = makeSession();
    const wizard = await generateWizard(session);
    expect(wizard.source).toBe('ai');
    expect(wizard.model).toBe('test-model');
    expect(session.counters.aiCalls).toBe(1);
  });
});
