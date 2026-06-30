import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskStatus } from '@shadchanai/shared';
import { NotFoundError, BusinessRuleError, ForbiddenError } from '../../utils/errors.js';

const h = vi.hoisted(() => ({
  Task: { findById: vi.fn() },
  auditMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../models/index.js', () => ({ Task: h.Task }));
vi.mock('../../services/audit.service.js', () => ({ audit: (...a: unknown[]) => h.auditMock(...a) }));

import {
  getTaskById,
  updateTask,
  completeTask,
  reassignTask,
} from './task.service.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';

const ID = '507f1f77bcf86cd799439011';
const OWNER = '507f1f77bcf86cd799439001';
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

beforeEach(() => vi.clearAllMocks());

describe('getTaskById', () => {
  it('throws NotFoundError when missing', async () => {
    h.Task.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
    await expect(getTaskById(ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('updateTask', () => {
  it('refuses to update a completed task', async () => {
    const doc = fakeDoc({ _id: ID, status: TaskStatus.COMPLETED, ownerUserId: OWNER });
    h.Task.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(updateTask(ID, { title: 'x' } as never, OWNER))
      .rejects.toBeInstanceOf(BusinessRuleError);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('refuses to update a cancelled task', async () => {
    const doc = fakeDoc({ _id: ID, status: TaskStatus.CANCELLED, ownerUserId: OWNER });
    h.Task.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(updateTask(ID, {} as never, OWNER)).rejects.toBeInstanceOf(BusinessRuleError);
  });

  it('blocks an unrelated non-admin actor (not owner, not assignee)', async () => {
    const doc = fakeDoc({ _id: ID, status: TaskStatus.OPEN, ownerUserId: OWNER, assignedTo: 'someoneElse' });
    h.Task.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(updateTask(ID, {} as never, 'intruder', mkActor('intruder')))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it('applies the patch, saves and audits for the owner', async () => {
    const doc = fakeDoc({ _id: ID, status: TaskStatus.OPEN, ownerUserId: OWNER, priority: 'normal' });
    h.Task.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await updateTask(ID, { priority: 'high' } as never, OWNER, mkActor(OWNER));
    expect(doc.priority).toBe('high');
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(h.auditMock).toHaveBeenCalledTimes(1);
  });
});

describe('completeTask', () => {
  it('is idempotent — returns early if already completed without re-saving', async () => {
    const doc = fakeDoc({ _id: ID, status: TaskStatus.COMPLETED, ownerUserId: OWNER });
    h.Task.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    const result = await completeTask(ID, 'note', OWNER);
    expect(result).toBe(doc);
    expect(doc.save).not.toHaveBeenCalled();
    expect(h.auditMock).not.toHaveBeenCalled();
  });

  it('transitions an open task to COMPLETED with completion metadata', async () => {
    const doc = fakeDoc({
      _id: ID, status: TaskStatus.OPEN, ownerUserId: OWNER,
      completedAt: undefined as Date | undefined,
      completionNote: undefined as string | undefined,
    });
    h.Task.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await completeTask(ID, 'done', OWNER);
    expect(doc.status).toBe(TaskStatus.COMPLETED);
    expect(doc.completedAt).toBeInstanceOf(Date);
    expect(doc.completionNote).toBe('done');
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(h.auditMock).toHaveBeenCalledTimes(1);
  });

  it('allows the assignee to complete', async () => {
    const ASSIGNEE = '507f1f77bcf86cd799439003';
    const doc = fakeDoc({ _id: ID, status: TaskStatus.OPEN, ownerUserId: OWNER, assignedTo: ASSIGNEE });
    h.Task.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(completeTask(ID, undefined, ASSIGNEE, mkActor(ASSIGNEE))).resolves.toBe(doc);
  });
});

describe('reassignTask', () => {
  it('sets a new assignee and audits the reassign transition', async () => {
    const doc = fakeDoc({
      _id: ID, status: TaskStatus.OPEN, ownerUserId: OWNER,
      assignedTo: undefined as unknown,
    });
    h.Task.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    const NEW = '507f1f77bcf86cd799439002';
    await reassignTask(ID, NEW, OWNER, mkActor(OWNER));
    expect(String(doc.assignedTo)).toBe(NEW);
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(h.auditMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ transition: 'reassign' }),
    }));
  });
});
