import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExternalCandidateStatus } from '@shadchanai/shared';
import { NotFoundError, BusinessRuleError, ConflictError } from '../../utils/errors.js';
import { ForbiddenError } from '../../utils/errors.js';

const h = vi.hoisted(() => ({
  ExternalCandidate: { findById: vi.fn(), findOne: vi.fn(), create: vi.fn() },
  auditMock: vi.fn().mockResolvedValue(undefined),
  recordDuplicatePhone: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  ExternalCandidate: h.ExternalCandidate,
  InternalCandidate: {},
  MatchSuggestion: {},
}));
vi.mock('../../services/audit.service.js', () => ({ audit: (...a: unknown[]) => h.auditMock(...a) }));
vi.mock('../../services/monitoring/metrics.service.js', () => ({
  recordDuplicatePhone: (...a: unknown[]) => h.recordDuplicatePhone(...a),
  recordNotOwnerAttempt: vi.fn(),
}));
// Avoid pulling the (refactored) matching engine into this suite.
vi.mock('../../services/matching/matching.engine.js', () => ({ findMatches: vi.fn(() => []) }));

import {
  getExternalCandidateById,
  createExternalCandidate,
  updateExternalCandidate,
  archiveExternalCandidate,
} from './external-candidate.service.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';

const ID = '507f1f77bcf86cd799439011';
const PERFORMER = '507f1f77bcf86cd799439012';
const mkActor = (id: string, roles: string[] = []): AuthUser => ({ id, roles } as unknown as AuthUser);

function fakeDoc<T extends Record<string, unknown>>(props: T) {
  return {
    ...props,
    toObject() {
      const { toObject, save, ...rest } = this as Record<string, unknown>;
      return rest;
    },
    save: vi.fn().mockResolvedValue(undefined),
  };
}

/** Stub for ExternalCandidate.findOne(...).select(...).lean().exec() */
function stubFindOne(row: unknown) {
  h.ExternalCandidate.findOne.mockReturnValue({
    select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(row) }) }),
  });
}

beforeEach(() => vi.clearAllMocks());

describe('getExternalCandidateById', () => {
  it('throws NotFoundError when missing', async () => {
    h.ExternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
    await expect(getExternalCandidateById(ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('createExternalCandidate', () => {
  it('rejects a duplicate active candidate sharing the same canonical phone', async () => {
    stubFindOne({ _id: 'existing-123', firstName: 'A', lastName: 'B' });
    await expect(createExternalCandidate({ contactPhone: '050-123-4567' } as never, PERFORMER))
      .rejects.toBeInstanceOf(ConflictError);
    expect(h.recordDuplicatePhone).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'manual_create' }),
    );
    expect(h.ExternalCandidate.create).not.toHaveBeenCalled();
  });

  it('creates and audits when phone is unique, defaulting shareCard to not-approved', async () => {
    stubFindOne(null);
    const created = fakeDoc({ _id: ID, firstName: 'New' });
    h.ExternalCandidate.create.mockResolvedValue(created);

    const result = await createExternalCandidate({ contactPhone: '0521112222' } as never, PERFORMER);

    expect(result).toBe(created);
    const createArg = h.ExternalCandidate.create.mock.calls[0]![0] as Record<string, unknown>;
    expect((createArg['shareCard'] as { approvedForShare: boolean }).approvedForShare).toBe(false);
    expect(createArg['contactPhoneNormalized']).toBe('+972521112222');
    expect(h.auditMock).toHaveBeenCalledTimes(1);
  });

  it('skips the duplicate lookup entirely when no phone is provided', async () => {
    const created = fakeDoc({ _id: ID });
    h.ExternalCandidate.create.mockResolvedValue(created);
    await createExternalCandidate({} as never, PERFORMER);
    expect(h.ExternalCandidate.findOne).not.toHaveBeenCalled();
  });
});

describe('updateExternalCandidate', () => {
  it('refuses to update an archived candidate', async () => {
    const doc = fakeDoc({ _id: ID, archivedAt: new Date(), ownerUserId: PERFORMER });
    h.ExternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(updateExternalCandidate(ID, {} as never, PERFORMER)).rejects.toBeInstanceOf(BusinessRuleError);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('enforces ownership against a non-owner non-admin actor', async () => {
    const doc = fakeDoc({ _id: ID, ownerUserId: 'owner' });
    h.ExternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(updateExternalCandidate(ID, {} as never, 'intruder', mkActor('intruder')))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('re-normalizes contactPhone on edit and stamps lastSourceUpdateAt', async () => {
    const doc = fakeDoc({
      _id: ID, ownerUserId: PERFORMER,
      contactPhoneNormalized: undefined as string | undefined,
      lastSourceUpdateAt: undefined as Date | undefined,
    });
    h.ExternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await updateExternalCandidate(ID, { contactPhone: '050-9998888' } as never, PERFORMER);
    expect(doc.contactPhoneNormalized).toBe('+972509998888');
    expect(doc.lastSourceUpdateAt).toBeInstanceOf(Date);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(h.auditMock).toHaveBeenCalledTimes(1);
  });
});

describe('archiveExternalCandidate', () => {
  it('is a no-op when already archived', async () => {
    const doc = fakeDoc({ _id: ID, archivedAt: new Date(), ownerUserId: PERFORMER });
    h.ExternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await archiveExternalCandidate(ID, PERFORMER);
    expect(doc.save).not.toHaveBeenCalled();
    expect(h.auditMock).not.toHaveBeenCalled();
  });

  it('sets archivedAt + ARCHIVED status and audits', async () => {
    const doc = fakeDoc({
      _id: ID, ownerUserId: PERFORMER,
      archivedAt: undefined as Date | undefined,
      status: undefined as string | undefined,
    });
    h.ExternalCandidate.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await archiveExternalCandidate(ID, PERFORMER);
    expect(doc.archivedAt).toBeInstanceOf(Date);
    expect(doc.status).toBe(ExternalCandidateStatus.ARCHIVED);
    expect(h.auditMock).toHaveBeenCalledTimes(1);
  });
});
