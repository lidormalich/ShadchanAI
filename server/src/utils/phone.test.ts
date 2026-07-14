import { describe, expect, it } from 'vitest';
import { mergePhoneEntries, normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it('canonicalizes Israeli national format to E.164', () => {
    expect(normalizePhone('050-123-4567')).toBe('+972501234567');
    expect(normalizePhone('+972 50 123 4567')).toBe('+972501234567');
  });
});

describe('mergePhoneEntries', () => {
  it('unions differing numbers instead of dropping them', () => {
    const merged = mergePhoneEntries(
      [{ number: '050-1234567', source: 'card' }],
      [{ number: '052-9998877', source: 'merged_card' }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ number: '052-9998877', normalized: '+972529998877', source: 'merged_card' });
  });

  it('collapses the same number in different spellings into one entry', () => {
    const merged = mergePhoneEntries(
      [{ number: '050-1234567' }],
      [{ number: '+972501234567' }, { number: '0501234567' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.number).toBe('050-1234567');
  });

  it('fills a missing label from an addition but never overwrites an existing one', () => {
    const filled = mergePhoneEntries([{ number: '0501234567' }], [{ number: '050-1234567', label: 'אמא' }]);
    expect(filled[0]!.label).toBe('אמא');

    const kept = mergePhoneEntries(
      [{ number: '0501234567', label: 'שדכנית' }],
      [{ number: '050-1234567', label: 'אמא' }],
    );
    expect(kept[0]!.label).toBe('שדכנית');
  });

  it('dedups even when a number cannot be canonicalized (digit-string fallback)', () => {
    const merged = mergePhoneEntries([{ number: '12-34' }], [{ number: '1234' }, { number: '' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.normalized).toBeUndefined();
  });

  it('preserves insertion order: existing entries first, new additions appended', () => {
    const merged = mergePhoneEntries(
      [{ number: '0501111111' }, { number: '0502222222' }],
      [{ number: '0503333333' }],
    );
    expect(merged.map((e) => e.number)).toEqual(['0501111111', '0502222222', '0503333333']);
  });
});
