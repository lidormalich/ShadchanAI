import { describe, it, expect } from 'vitest';
import { isSamePerson, sigOf, attachPendingDuplicates, type PendingDuplicate } from './queue-duplicates.js';
import type { ExtractedProfile } from './regex.extractor.js';

const sig = (p: ExtractedProfile) => sigOf(p);
const row = (messageId: string, extractedFields: ExtractedProfile) =>
  ({ messageId, extractedFields, pendingDuplicates: [] as PendingDuplicate[] });

describe('isSamePerson', () => {
  it('same first name + same age (no surname) → same person', () => {
    expect(isSamePerson(sig({ firstName: 'שמרית', age: 39 }), sig({ firstName: 'שמרית', age: 39 }))).toBe(true);
  });

  it('same name + adjacent age (±1) → same person', () => {
    expect(isSamePerson(sig({ firstName: 'יוסי', lastName: 'כהן', age: 27 }), sig({ firstName: 'יוסי', lastName: 'כהן', age: 28 }))).toBe(true);
  });

  it('same first name but DIFFERENT surname → not same', () => {
    expect(isSamePerson(sig({ firstName: 'אפרת', lastName: 'טייב', age: 25 }), sig({ firstName: 'אפרת', lastName: 'חנימוב', age: 25 }))).toBe(false);
  });

  it('name matches but nothing corroborates (no age/phone/city) → not same', () => {
    expect(isSamePerson(sig({ firstName: 'שרה' }), sig({ firstName: 'שרה' }))).toBe(false);
  });

  it('same name + shared phone corroborates', () => {
    expect(isSamePerson(
      sig({ firstName: 'דנה', contactPhones: ['050-1234567'] }),
      sig({ firstName: 'דנה', contactPhones: ['0501234567'] }),
    )).toBe(true);
  });

  it('same name + same city corroborates', () => {
    expect(isSamePerson(sig({ firstName: 'מרים', city: 'נתיבות' }), sig({ firstName: 'מרים', city: 'נתיבות' }))).toBe(true);
  });

  it('different first name never matches', () => {
    expect(isSamePerson(sig({ firstName: 'יוסי', age: 30 }), sig({ firstName: 'משה', age: 30 }))).toBe(false);
  });
});

describe('attachPendingDuplicates', () => {
  it('groups reposts of the same person across the queue (transitively)', () => {
    const rows = [
      row('m1', { firstName: 'שמרית', age: 39 }),
      row('m2', { firstName: 'שמרית', age: 39 }),
      row('m3', { firstName: 'שמרית', age: 40 }), // ±1 bridges to m1/m2
      row('m4', { firstName: 'דוד', age: 24 }),
    ];
    attachPendingDuplicates(rows);
    // m1..m3 form one group; each lists the other two.
    expect(rows[0]!.pendingDuplicates.map((d) => d.messageId).sort()).toEqual(['m2', 'm3']);
    expect(rows[2]!.pendingDuplicates.map((d) => d.messageId).sort()).toEqual(['m1', 'm2']);
    // m4 is alone.
    expect(rows[3]!.pendingDuplicates).toEqual([]);
  });

  it('no duplicates → every row stays empty', () => {
    const rows = [
      row('a', { firstName: 'יוסי', age: 25 }),
      row('b', { firstName: 'משה', age: 30 }),
    ];
    attachPendingDuplicates(rows);
    expect(rows[0]!.pendingDuplicates).toEqual([]);
    expect(rows[1]!.pendingDuplicates).toEqual([]);
  });
});
