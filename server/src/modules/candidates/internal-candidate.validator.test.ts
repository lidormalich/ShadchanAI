import { describe, it, expect } from 'vitest';
import { Gender, SectorGroup, PersonalStatus, ReadinessForMarriage } from '@shadchanai/shared';
import {
  CreateInternalCandidateSchema,
  UpdateInternalCandidateSchema,
  MarkDatingSchema,
  ReopenCandidateSchema,
} from './internal-candidate.validator.js';

const validBase = {
  firstName: 'David',
  lastName: 'Cohen',
  gender: Gender.MALE,
  dateOfBirth: '1995-01-01',
  sectorGroup: SectorGroup.DATI_LEUMI,
  readinessForMarriage: ReadinessForMarriage.ACTIVELY_LOOKING,
};

describe('CreateInternalCandidateSchema', () => {
  it('accepts a minimal valid payload and applies defaults', () => {
    const parsed = CreateInternalCandidateSchema.parse(validBase);
    // personalStatus + numberOfChildren + openness defaults
    expect(parsed.personalStatus).toBe(PersonalStatus.SINGLE);
    expect(parsed.numberOfChildren).toBe(0);
    expect(parsed.openness.openToDivorced).toBe(false);
  });

  it('coerces a date string to a Date', () => {
    const parsed = CreateInternalCandidateSchema.parse(validBase);
    expect(parsed.dateOfBirth).toBeInstanceOf(Date);
  });

  it('rejects a missing required field (readinessForMarriage)', () => {
    const { readinessForMarriage, ...rest } = validBase;
    expect(CreateInternalCandidateSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty firstName after trim', () => {
    const r = CreateInternalCandidateSchema.safeParse({ ...validBase, firstName: '   ' });
    expect(r.success).toBe(false);
  });

  it('rejects an out-of-range height', () => {
    expect(CreateInternalCandidateSchema.safeParse({ ...validBase, height: 50 }).success).toBe(false);
    expect(CreateInternalCandidateSchema.safeParse({ ...validBase, height: 170 }).success).toBe(true);
  });

  it('rejects an invalid email and an invalid photo url', () => {
    expect(CreateInternalCandidateSchema.safeParse({ ...validBase, email: 'not-an-email' }).success).toBe(false);
    expect(CreateInternalCandidateSchema.safeParse({ ...validBase, photoUrl: 'not-a-url' }).success).toBe(false);
  });

  it('rejects an invalid hard-constraint operator', () => {
    const r = CreateInternalCandidateSchema.safeParse({
      ...validBase,
      hardConstraints: [{ field: 'sectorGroup', operator: 'bogus', value: 'x' }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts a valid hard constraint and soft preference', () => {
    const r = CreateInternalCandidateSchema.safeParse({
      ...validBase,
      hardConstraints: [{ field: 'sectorGroup', operator: 'eq', value: 'haredi' }],
      softPreferences: [{ field: 'city', value: 'Jerusalem', importance: 'important' }],
    });
    expect(r.success).toBe(true);
  });

  it('caps hardConstraints at 20 entries', () => {
    const many = Array.from({ length: 21 }, () => ({ field: 'city', operator: 'eq' as const, value: 'x' }));
    expect(CreateInternalCandidateSchema.safeParse({ ...validBase, hardConstraints: many }).success).toBe(false);
  });
});

describe('UpdateInternalCandidateSchema', () => {
  it('is fully partial — an empty object is valid', () => {
    expect(UpdateInternalCandidateSchema.safeParse({}).success).toBe(true);
  });

  it('still validates the fields that are present', () => {
    expect(UpdateInternalCandidateSchema.safeParse({ height: 9999 }).success).toBe(false);
    expect(UpdateInternalCandidateSchema.safeParse({ city: 'Haifa' }).success).toBe(true);
  });
});

describe('MarkDatingSchema', () => {
  const OID = '507f1f77bcf86cd799439011';

  it('requires a valid 24-hex partnerCandidateId', () => {
    expect(MarkDatingSchema.safeParse({ partnerCandidateId: OID }).success).toBe(true);
    expect(MarkDatingSchema.safeParse({ partnerCandidateId: 'short' }).success).toBe(false);
  });
});

describe('ReopenCandidateSchema', () => {
  it('defaults reason to did_not_match', () => {
    expect(ReopenCandidateSchema.parse({}).reason).toBe('did_not_match');
  });

  it('rejects an unknown reason', () => {
    expect(ReopenCandidateSchema.safeParse({ reason: 'whatever' }).success).toBe(false);
  });
});
