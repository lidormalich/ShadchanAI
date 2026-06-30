import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { assertOwnership, assertOwnershipOrAssignee } from './ownership.assert.js';
import { ForbiddenError } from './errors.js';
import type { AuthUser } from '../middleware/auth.middleware.js';

const mkUser = (id: string, roles: string[] = []): AuthUser =>
  ({ id, roles } as unknown as AuthUser);

const opts = { entity: 'internal candidate' };

describe('assertOwnership', () => {
  it('allows the owner (string id)', () => {
    expect(() => assertOwnership('u1', mkUser('u1'), opts)).not.toThrow();
  });

  it('allows the owner when stored as ObjectId vs string user id', () => {
    const oid = new Types.ObjectId();
    expect(() => assertOwnership(oid, mkUser(String(oid)), opts)).not.toThrow();
  });

  it('allows an admin to mutate someone else’s entity', () => {
    expect(() => assertOwnership('owner', mkUser('other', ['admin']), opts)).not.toThrow();
  });

  it('blocks a non-owner non-admin with ForbiddenError code=not_owner (403)', () => {
    try {
      assertOwnership('owner', mkUser('intruder'), opts);
      throw new Error('expected ForbiddenError');
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).code).toBe('not_owner');
      expect((e as unknown as { status: number }).status).toBe(403);
    }
  });

  it('is permissive for legacy unowned rows (no owner set)', () => {
    expect(() => assertOwnership(undefined, mkUser('anyone'), opts)).not.toThrow();
    expect(() => assertOwnership(null, mkUser('anyone'), opts)).not.toThrow();
  });
});

describe('assertOwnershipOrAssignee', () => {
  it('allows the owner', () => {
    expect(() => assertOwnershipOrAssignee('u1', 'u2', mkUser('u1'), opts)).not.toThrow();
  });

  it('allows the assignee', () => {
    expect(() => assertOwnershipOrAssignee('u1', 'u2', mkUser('u2'), opts)).not.toThrow();
  });

  it('allows an admin', () => {
    expect(() => assertOwnershipOrAssignee('u1', 'u2', mkUser('x', ['admin']), opts)).not.toThrow();
  });

  it('blocks an unrelated non-admin', () => {
    expect(() => assertOwnershipOrAssignee('u1', 'u2', mkUser('x'), opts)).toThrow(ForbiddenError);
  });

  it('is permissive when neither owner nor assignee is set', () => {
    expect(() => assertOwnershipOrAssignee(undefined, undefined, mkUser('x'), opts)).not.toThrow();
  });
});
