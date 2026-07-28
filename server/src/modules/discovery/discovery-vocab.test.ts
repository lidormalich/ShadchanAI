import { describe, it, expect } from 'vitest';
import { sanitizeTraitPicks, isValidWizardQuestion, buildStaticWizard } from './discovery-vocab.js';
import type { IDiscoveryWizardQuestion } from './discovery-session.model.js';

describe('sanitizeTraitPicks', () => {
  it('keeps valid picks and normalizes a reversed age range', () => {
    const out = sanitizeTraitPicks({
      ageMin: 35, ageMax: 25,
      regions: ['jerusalem', 'gush_dan'],
      openness: { openToDivorced: true },
      softPreferences: [{ field: 'lifestyleTone', value: 'moderate', importance: 'important' }],
      freeText: '  חשוב לי בית של תורה  ',
    });
    expect(out.ageMin).toBe(25);
    expect(out.ageMax).toBe(35);
    expect(out.regions).toEqual(['jerusalem', 'gush_dan']);
    expect(out.openness).toEqual({ openToDivorced: true });
    expect(out.softPreferences).toEqual([
      { field: 'lifestyleTone', value: 'moderate', importance: 'important' },
    ]);
    expect(out.freeText).toBe('חשוב לי בית של תורה');
  });

  it('drops everything off-vocabulary (the vocabulary is the law)', () => {
    const out = sanitizeTraitPicks({
      ageMin: 5, ageMax: 300, // out of range
      regions: ['narnia', 'jerusalem'],
      openness: { openToDivorced: 'yes' as unknown as boolean, hacked: true } as Record<string, unknown>,
      softPreferences: [
        { field: 'phone', value: '050', importance: 'must_have' },        // unknown field
        { field: 'lifestyleTone', value: 'nonexistent', importance: 'x' }, // unknown value
      ],
    });
    expect(out.ageMin).toBeUndefined();
    expect(out.ageMax).toBeUndefined();
    expect(out.regions).toEqual(['jerusalem']);
    expect(out.openness).toBeUndefined();
    expect(out.softPreferences).toBeUndefined();
  });

  it('caps freeText at 300 chars', () => {
    const out = sanitizeTraitPicks({ freeText: 'א'.repeat(500) });
    expect(out.freeText).toHaveLength(300);
  });

  it('defaults unknown importance to "important"', () => {
    const out = sanitizeTraitPicks({
      softPreferences: [{ field: 'sectorGroup', value: 'haredi', importance: 'whatever' }],
    });
    expect(out.softPreferences?.[0]?.importance).toBe('important');
  });
});

describe('isValidWizardQuestion', () => {
  const base: IDiscoveryWizardQuestion = {
    id: 'q1', question: 'שאלה', type: 'multi', mapsTo: 'soft:lifestyleTone',
    options: [{ value: 'moderate', label: 'ממוצע' }],
  };

  it('accepts on-vocabulary questions', () => {
    expect(isValidWizardQuestion(base)).toBe(true);
  });

  it('rejects an unknown mapsTo field', () => {
    expect(isValidWizardQuestion({ ...base, mapsTo: 'soft:salary' })).toBe(false);
    expect(isValidWizardQuestion({ ...base, mapsTo: 'phone' })).toBe(false);
  });

  it('rejects off-vocabulary option values for soft fields', () => {
    expect(isValidWizardQuestion({
      ...base,
      options: [{ value: 'party_animal', label: 'חיית מסיבות' }],
    })).toBe(false);
  });

  it('rejects non-yes/no options for openness questions', () => {
    expect(isValidWizardQuestion({
      ...base, mapsTo: 'openness.openToDivorced',
      options: [{ value: 'maybe', label: 'אולי' }],
    })).toBe(false);
    expect(isValidWizardQuestion({
      ...base, mapsTo: 'openness.openToDivorced',
      options: [{ value: 'yes', label: 'כן' }, { value: 'no', label: 'לא' }],
    })).toBe(true);
  });
});

describe('buildStaticWizard', () => {
  it('seeds the age question from existing agePreferences and passes its own validation', () => {
    const wizard = buildStaticWizard({ agePreferences: { min: 22, max: 28 } });
    const age = wizard.questions.find((q) => q.mapsTo === 'ageRange');
    expect(age?.options[0]?.value).toBe('22');
    expect(age?.options[1]?.value).toBe('28');
    expect(wizard.source).toBe('static');
    expect(wizard.questions.every(isValidWizardQuestion)).toBe(true);
  });
});
