import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────
const sessionFindOne = vi.fn();
const sessionCreate = vi.fn();
const sessionUpdateMany = vi.fn();

vi.mock('./discovery-session.model.js', () => ({
  DiscoverySession: {
    findOne: (...a: unknown[]) => sessionFindOne(...a),
    create: (...a: unknown[]) => sessionCreate(...a),
    updateMany: (...a: unknown[]) => sessionUpdateMany(...a),
    find: vi.fn(),
    findById: vi.fn(),
  },
}));

const getSettingCached = vi.fn();
vi.mock('../settings/settings.service.js', () => ({
  getSettingCached: (...a: unknown[]) => getSettingCached(...a),
}));

const internalFindById = vi.fn();
vi.mock('../../models/index.js', () => ({
  InternalCandidate: { findById: (...a: unknown[]) => internalFindById(...a) },
  ExternalCandidate: { find: vi.fn() },
}));

import { createSession, resolveActiveSession, TOKEN_RE } from './discovery-session.service.js';
import { BusinessRuleError } from '../../utils/errors.js';

const INTERNAL_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f1f77bcf86cd799439012';

beforeEach(() => {
  vi.clearAllMocks();
  getSettingCached.mockImplementation(async (key: string) => {
    if (key === 'discovery.enabled') return true;
    if (key === 'discovery.session_ttl_days') return 7;
    return true;
  });
});

describe('createSession', () => {
  it('mints a token matching the public-token grammar and revokes prior open sessions', async () => {
    internalFindById.mockReturnValue({
      select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue({ firstName: 'א' }) }) }),
    });
    sessionUpdateMany.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });
    sessionCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: 'x' }));

    const { session, path } = await createSession(INTERNAL_ID, USER_ID);

    expect(TOKEN_RE.test(session.token)).toBe(true);
    expect(path).toBe(`/meet/${session.token}`);
    // Prior open sessions were revoked (one open link per candidate).
    expect(sessionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $in: ['pending_traits', 'active'] } }),
      { $set: { status: 'revoked' } },
    );
    // 7-day TTL applied.
    const expiresAt = (sessionCreate.mock.calls[0]![0] as { expiresAt: Date }).expiresAt;
    const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('refuses when the feature toggle is off', async () => {
    getSettingCached.mockResolvedValue(false);
    await expect(createSession(INTERNAL_ID, USER_ID)).rejects.toBeInstanceOf(BusinessRuleError);
  });
});

describe('resolveActiveSession', () => {
  it('rejects malformed tokens without touching the DB', async () => {
    const result = await resolveActiveSession('short');
    expect(result.kind).toBe('not_found');
    expect(sessionFindOne).not.toHaveBeenCalled();
  });

  it('returns disabled when the feature toggle is off', async () => {
    getSettingCached.mockResolvedValue(false);
    const result = await resolveActiveSession('A'.repeat(32));
    expect(result.kind).toBe('disabled');
  });

  it('treats a revoked session as not found', async () => {
    sessionFindOne.mockReturnValue({ exec: vi.fn().mockResolvedValue({ status: 'revoked' }) });
    const result = await resolveActiveSession('A'.repeat(32));
    expect(result.kind).toBe('not_found');
  });

  it('lazily flips an overdue open session to expired', async () => {
    const save = vi.fn();
    const session = {
      status: 'active',
      expiresAt: new Date(Date.now() - 1000),
      save,
    };
    sessionFindOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(session) });

    const result = await resolveActiveSession('A'.repeat(32));
    expect(result.kind).toBe('expired');
    expect(session.status).toBe('expired');
    expect(save).toHaveBeenCalled();
  });

  it('a COMPLETED session stays reachable past its expiry (done screen)', async () => {
    const session = {
      status: 'completed',
      expiresAt: new Date(Date.now() - 1000),
      save: vi.fn(),
    };
    sessionFindOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(session) });

    const result = await resolveActiveSession('A'.repeat(32));
    expect(result.kind).toBe('ok');
    expect(session.save).not.toHaveBeenCalled();
  });

  it('returns ok for a live session', async () => {
    const session = { status: 'active', expiresAt: new Date(Date.now() + 60_000), save: vi.fn() };
    sessionFindOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(session) });
    const result = await resolveActiveSession('A'.repeat(32));
    expect(result.kind).toBe('ok');
  });
});
