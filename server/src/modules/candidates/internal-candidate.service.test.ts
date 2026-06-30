import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidateStatus } from '@shadchanai/shared';
import { BusinessRuleError, NotFoundError } from '../../utils/errors.js';
import { ForbiddenError } from '../../utils/errors.js';

// ── Mocks ────────────────────────────────────────────────
// Follow the project convention (see audit.service.test.ts): mock the
// model barrel + the audit side-effect so nothing touches a real DB.

const { InternalCandidate, MatchSuggestion, auditMock } = vi.hoisted(() => ({
  InternalCandidate: { findById: vi.fn(), create: vi.fn() },
  MatchSuggestion: { updateOne: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(undefined) })) },
  auditMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../models/index.js', () => ({
  InternalCandidate,
  MatchSuggestion,
  Conversation: {},
  ExternalCandidate: {},
}));

vi.mock('../../services/audit.service.js', () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

import {
  computeReadiness,
  getInternalCandidateById,
  updateInternalCandidate,
  markInternalCandidateDating,
  reopenInternalCandidate,
} from './internal-candidate.service.js';
import type { IInternalCandidate } from '../../models/index.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';

const mkActor = (id: string, roles: string[] = []): AuthUser => ({ id, roles } as unknown as AuthUser);

/** A minimal fake mongoose doc with the methods the service calls.
 *  Generic so the passed props remain named properties (avoids TS4111
 *  index-signature access under the strict tsconfig). */
function fakeDoc<T extends Record<string, unknown>>(props: T) {
  const doc = {
    ...props,
    toObject() {
      const { toObject, save, ...rest } = this as Record<string, unknown>;
      return rest;
    },
    save: vi.fn().mockResolvedValue(undefined),
  };
  return doc;
}

const ID = '507f1f77bcf86cd799439011';

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════
// computeReadiness — pure business logic (no mocks needed)
// ══════════════════════════════════════════════════════════

describe('computeReadiness', () => {
  const FULL: Partial<IInternalCandidate> = {
    firstName: 'David',
    lastName: 'Cohen',
    gender: 'male',
    dateOfBirth: new Date('1995-01-01'),
    sectorGroup: 'dati_leumi',
    readinessForMarriage: 'actively_looking',
    city: 'Jerusalem',
    subSector: 'dati_leumi_classic',
    lifestyleTone: 'moderate',
    lifeStage: 'early_career',
    studyWorkDirection: 'working',
    about: 'about text',
    whatSeeking: 'seeking text',
    photoUrl: 'https://x/p.jpg',
    photoApproved: true,
    phone: '0500000000',
    referenceName: 'Rabbi X',
  };

  it('reports 100% completion and no blockers for a complete profile', () => {
    const r = computeReadiness(FULL);
    expect(r.profileCompletion).toBe(100);
    expect(r.missingCriticalFields).toEqual([]);
    expect(r.sendReadinessBlockers).toEqual([]);
  });

  it('lists every missing critical field by name', () => {
    const r = computeReadiness({});
    expect(r.missingCriticalFields).toEqual([
      'firstName', 'lastName', 'gender', 'dateOfBirth', 'sectorGroup', 'readinessForMarriage',
    ]);
    expect(r.sendReadinessBlockers.some((b) => b.startsWith('Missing critical fields'))).toBe(true);
  });

  it('treats blank/whitespace strings and invalid dates as missing', () => {
    const r = computeReadiness({
      ...FULL,
      firstName: '   ',
      dateOfBirth: new Date('not-a-date'),
    });
    expect(r.missingCriticalFields).toContain('firstName');
    expect(r.missingCriticalFields).toContain('dateOfBirth');
  });

  it('blocks send when a photo exists but is not approved', () => {
    const r = computeReadiness({ ...FULL, photoApproved: false });
    expect(r.sendReadinessBlockers).toContain('Photo not yet approved');
  });

  it('blocks send when completion is below 60%', () => {
    // only critical fields present → 6 of 15 = 40%
    const r = computeReadiness({
      firstName: 'A', lastName: 'B', gender: 'male',
      dateOfBirth: new Date('1995-01-01'), sectorGroup: 'dati_leumi',
      readinessForMarriage: 'actively_looking',
    } as Partial<IInternalCandidate>);
    expect(r.profileCompletion).toBe(40);
    expect(r.sendReadinessBlockers.some((b) => b.includes('below 60%'))).toBe(true);
  });

  it('blocks send when no reference is provided', () => {
    const { referenceName, ...noRef } = FULL;
    const r = computeReadiness(noRef);
    expect(r.sendReadinessBlockers).toContain('No reference provided');
  });

  it('accepts a reference phone in lieu of a reference name', () => {
    const { referenceName, ...rest } = FULL;
    const r = computeReadiness({ ...rest, referencePhone: '0500000001' });
    expect(r.sendReadinessBlockers).not.toContain('No reference provided');
  });
});

// ══════════════════════════════════════════════════════════
// getInternalCandidateById
// ══════════════════════════════════════════════════════════

describe('getInternalCandidateById', () => {
  it('throws NotFoundError when the candidate does not exist', async () => {
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
    await expect(getInternalCandidateById(ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns the document when found', async () => {
    const doc = fakeDoc({ _id: ID, firstName: 'A' });
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(getInternalCandidateById(ID)).resolves.toBe(doc);
  });
});

// ══════════════════════════════════════════════════════════
// updateInternalCandidate — closure invariants + ownership
// ══════════════════════════════════════════════════════════

describe('updateInternalCandidate', () => {
  it('refuses to edit a closed candidate', async () => {
    const doc = fakeDoc({ _id: ID, status: CandidateStatus.CLOSED, ownerUserId: 'u1' });
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(updateInternalCandidate(ID, { city: 'Tel Aviv' }, 'u1'))
      .rejects.toMatchObject({ message: expect.stringContaining('closed') });
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('refuses to edit an archived candidate', async () => {
    const doc = fakeDoc({ _id: ID, status: CandidateStatus.ACTIVE, archivedAt: new Date(), ownerUserId: 'u1' });
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(updateInternalCandidate(ID, { city: 'Tel Aviv' }, 'u1'))
      .rejects.toMatchObject({ message: expect.stringContaining('archived') });
  });

  it('enforces ownership against a non-owner non-admin actor', async () => {
    const doc = fakeDoc({ _id: ID, status: CandidateStatus.ACTIVE, ownerUserId: 'owner' });
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(updateInternalCandidate(ID, { city: 'X' }, 'intruder', mkActor('intruder')))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('recomputes readiness, stamps lastActionAt, saves and audits on success', async () => {
    const doc = fakeDoc({
      _id: ID,
      status: CandidateStatus.ACTIVE,
      ownerUserId: 'u1',
      firstName: 'David', lastName: 'Cohen', gender: 'male',
      dateOfBirth: new Date('1995-01-01'), sectorGroup: 'dati_leumi',
      readinessForMarriage: 'actively_looking',
      // mutated by the service — declared so they stay named props
      city: undefined as string | undefined,
      profileCompletion: 0,
      missingCriticalFields: [] as string[],
      lastActionAt: undefined as Date | undefined,
    });
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });

    const result = await updateInternalCandidate(ID, { city: 'Jerusalem' }, 'u1');

    expect(result).toBe(doc);
    expect(doc.city).toBe('Jerusalem');
    expect(typeof (doc.profileCompletion as number)).toBe('number');
    expect(Array.isArray(doc.missingCriticalFields)).toBe(true);
    expect(doc.lastActionAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════
// markInternalCandidateDating — dating lock
// ══════════════════════════════════════════════════════════

describe('markInternalCandidateDating', () => {
  const PARTNER = '507f1f77bcf86cd799439099';

  it('refuses to mark a closed candidate as dating', async () => {
    const doc = fakeDoc({ _id: ID, status: CandidateStatus.CLOSED, ownerUserId: 'u1' });
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(markInternalCandidateDating(ID, PARTNER, undefined, 'u1'))
      .rejects.toBeInstanceOf(BusinessRuleError);
  });

  it('refuses to switch to a different dating partner', async () => {
    const doc = fakeDoc({
      _id: ID,
      status: CandidateStatus.ACTIVE,
      ownerUserId: 'u1',
      datingPartnerCandidateId: '507f1f77bcf86cd799439001',
    });
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(markInternalCandidateDating(ID, PARTNER, undefined, 'u1'))
      .rejects.toMatchObject({ message: expect.stringContaining('already dating') });
  });

  it('transitions an active candidate to DATING and audits', async () => {
    const doc = fakeDoc({
      _id: ID, status: CandidateStatus.ACTIVE, ownerUserId: 'u1',
      datingStartedAt: undefined as Date | undefined,
    });
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });

    await markInternalCandidateDating(ID, PARTNER, undefined, 'u1');

    expect(doc.status).toBe(CandidateStatus.DATING);
    expect(doc.datingStartedAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════
// reopenInternalCandidate — reopen guard + match deferral
// ══════════════════════════════════════════════════════════

describe('reopenInternalCandidate', () => {
  it('refuses to reopen an active candidate', async () => {
    const doc = fakeDoc({ _id: ID, status: CandidateStatus.ACTIVE, ownerUserId: 'u1' });
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(reopenInternalCandidate(ID, undefined, 'requested', undefined, 'u1'))
      .rejects.toBeInstanceOf(BusinessRuleError);
  });

  it('reopens a dating candidate, clears dating fields, and defers the source match', async () => {
    const matchId = '507f1f77bcf86cd799439055';
    const doc = fakeDoc({
      _id: ID,
      status: CandidateStatus.DATING,
      ownerUserId: 'u1',
      datingPartnerCandidateId: '507f1f77bcf86cd799439001',
      closureReason: 'something',
    });
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    const updateExec = vi.fn().mockResolvedValue(undefined);
    MatchSuggestion.updateOne.mockReturnValue({ exec: updateExec });

    await reopenInternalCandidate(ID, matchId, 'did_not_match', undefined, 'u1');

    expect(doc.status).toBe(CandidateStatus.ACTIVE);
    expect(doc.datingPartnerCandidateId).toBeUndefined();
    expect(doc.closureReason).toBeUndefined();
    expect(MatchSuggestion.updateOne).toHaveBeenCalledTimes(1);
    expect(updateExec).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it('does not touch any match when no valid fromDatingMatchId is given', async () => {
    const doc = fakeDoc({ _id: ID, status: CandidateStatus.CLOSED, ownerUserId: 'u1' });
    InternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });

    await reopenInternalCandidate(ID, undefined, 'requested', undefined, 'u1');

    expect(MatchSuggestion.updateOne).not.toHaveBeenCalled();
    expect(doc.status).toBe(CandidateStatus.ACTIVE);
  });
});
