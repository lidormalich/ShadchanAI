import { describe, it, expect } from 'vitest';
import { booleanString, optionalBooleanString } from './zod-bool.js';

describe('booleanString', () => {
  const schema = booleanString(false);

  it('parses "false" as false (the z.coerce.boolean bug)', () => {
    expect(schema.parse('false')).toBe(false);
    expect(schema.parse('FALSE')).toBe(false);
    expect(schema.parse('0')).toBe(false);
    expect(schema.parse('no')).toBe(false);
    expect(schema.parse('off')).toBe(false);
  });

  it('parses truthy string forms as true', () => {
    expect(schema.parse('true')).toBe(true);
    expect(schema.parse('TRUE')).toBe(true);
    expect(schema.parse('1')).toBe(true);
    expect(schema.parse('yes')).toBe(true);
    expect(schema.parse('on')).toBe(true);
  });

  it('passes real booleans through', () => {
    expect(schema.parse(true)).toBe(true);
    expect(schema.parse(false)).toBe(false);
  });

  it('falls back to the default when unset or empty', () => {
    expect(booleanString(true).parse(undefined)).toBe(true);
    expect(booleanString(false).parse(undefined)).toBe(false);
    expect(booleanString(true).parse('')).toBe(true);
    expect(booleanString(true).parse('   ')).toBe(true);
  });

  it('rejects garbage with a type error', () => {
    expect(() => schema.parse('maybe')).toThrow();
  });
});

describe('optionalBooleanString', () => {
  const schema = optionalBooleanString();

  it('returns undefined for unset/empty', () => {
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse('')).toBeUndefined();
  });

  it('parses "false" as false', () => {
    expect(schema.parse('false')).toBe(false);
    expect(schema.parse('true')).toBe(true);
  });
});
