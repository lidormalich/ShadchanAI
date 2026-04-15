import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditActionType, AuditEntityType } from '@shadchanai/shared';

// Mock env before importing audit service
const envMock: { STRICT_AUDIT: boolean } = { STRICT_AUDIT: false };
vi.mock('../config/env.js', () => ({
  env: new Proxy({}, { get: (_t, prop) => (envMock as Record<string, unknown>)[prop as string] }),
}));

const createMock = vi.fn();
vi.mock('../models/index.js', () => ({
  AuditLog: { create: (...args: unknown[]) => createMock(...args) },
}));

import { audit, getAuditFailureCount } from './audit.service.js';

const sampleInput = {
  entityType: AuditEntityType.MATCH_SUGGESTION,
  entityId: '507f1f77bcf86cd799439011',
  actionType: AuditActionType.CREATE,
  performedBy: '507f1f77bcf86cd799439012',
};

describe('audit.service', () => {
  beforeEach(() => {
    createMock.mockReset();
    envMock.STRICT_AUDIT = false;
  });

  it('swallows write failures by default and increments the failure counter', async () => {
    createMock.mockRejectedValueOnce(new Error('db down'));
    const before = getAuditFailureCount();
    await expect(audit(sampleInput)).resolves.toBeUndefined();
    expect(getAuditFailureCount()).toBe(before + 1);
  });

  it('rethrows when STRICT_AUDIT is true', async () => {
    envMock.STRICT_AUDIT = true;
    createMock.mockRejectedValueOnce(new Error('db down'));
    await expect(audit(sampleInput)).rejects.toThrow('db down');
  });
});
