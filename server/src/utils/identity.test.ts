import { describe, it, expect } from 'vitest';
import { buildIdentityKey, normalizeNamePart } from './identity.js';

describe('normalizeNamePart', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeNamePart('  Yossi   Cohen ')).toBe('yossi cohen');
  });

  it('strips gershayim, quotes, dots and dashes', () => {
    expect(normalizeNamePart('בן-ציון')).toBe('בןציון');
    expect(normalizeNamePart('כ״ץ')).toBe('כץ');
    expect(normalizeNamePart("או'ר")).toBe('אור');
  });

  it('strips Hebrew niqqud so vowelized/plain names converge', () => {
    // יוֹסֵף (with niqqud) → יוסף
    expect(normalizeNamePart('יוֹסֵף')).toBe(normalizeNamePart('יוסף'));
  });

  it('returns empty string for nullish input', () => {
    expect(normalizeNamePart(undefined)).toBe('');
    expect(normalizeNamePart(null)).toBe('');
    expect(normalizeNamePart('')).toBe('');
  });
});

describe('buildIdentityKey', () => {
  it('builds a normalized name|name|age key when all parts present', () => {
    expect(buildIdentityKey('יוסף', 'כהן', 27)).toBe('יוסף|כהן|27');
  });

  it('converges spacing/casing/niqqud variants of the same person', () => {
    expect(buildIdentityKey(' יוֹסֵף ', 'כהן', 27)).toBe(buildIdentityKey('יוסף', 'כהן', 27));
  });

  it('is undefined when any of firstName / lastName / age is missing', () => {
    expect(buildIdentityKey('יוסף', undefined, 27)).toBeUndefined();
    expect(buildIdentityKey(undefined, 'כהן', 27)).toBeUndefined();
    expect(buildIdentityKey('יוסף', 'כהן', undefined)).toBeUndefined();
    expect(buildIdentityKey('יוסף', 'כהן', null)).toBeUndefined();
  });

  it('distinguishes different exact ages (±1 is the matcher/review job, not the key)', () => {
    expect(buildIdentityKey('יוסף', 'כהן', 27)).not.toBe(buildIdentityKey('יוסף', 'כהן', 28));
  });
});
