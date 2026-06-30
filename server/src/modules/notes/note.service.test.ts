import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoteVisibility } from '@shadchanai/shared';
import { NotFoundError, ForbiddenError } from '../../utils/errors.js';

const h = vi.hoisted(() => ({
  Note: { findById: vi.fn() },
  auditMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../models/index.js', () => ({ Note: h.Note }));
vi.mock('../../services/audit.service.js', () => ({ audit: (...a: unknown[]) => h.auditMock(...a) }));

import { getNoteById, updateNote, deleteNote } from './note.service.js';

const ID = '507f1f77bcf86cd799439011';
const AUTHOR = '507f1f77bcf86cd799439001';
const OTHER = '507f1f77bcf86cd799439002';

function fakeDoc<T extends Record<string, unknown>>(props: T) {
  return {
    ...props,
    toObject() {
      const { toObject, save, deleteOne, ...rest } = this as Record<string, unknown>;
      return rest;
    },
    save: vi.fn().mockResolvedValue(undefined),
    deleteOne: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('getNoteById', () => {
  it('throws NotFoundError when missing', async () => {
    h.Note.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
    await expect(getNoteById(ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('updateNote', () => {
  it('blocks a non-author non-admin from editing', async () => {
    const doc = fakeDoc({ _id: ID, authorUserId: AUTHOR, body: 'x', visibility: NoteVisibility.INTERNAL });
    h.Note.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(updateNote(ID, { body: 'y' } as never, OTHER, false))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('lets an admin edit a note they did not author', async () => {
    const doc = fakeDoc({ _id: ID, authorUserId: AUTHOR, body: 'x', visibility: NoteVisibility.INTERNAL });
    h.Note.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await updateNote(ID, { body: 'edited' } as never, OTHER, true);
    expect(doc.body).toBe('edited');
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(h.auditMock).toHaveBeenCalledTimes(1);
  });

  it('applies only the provided fields for the author', async () => {
    const doc = fakeDoc({ _id: ID, authorUserId: AUTHOR, body: 'orig', visibility: NoteVisibility.INTERNAL, pinned: false });
    h.Note.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await updateNote(ID, { pinned: true } as never, AUTHOR, false);
    expect(doc.pinned).toBe(true);
    expect(doc.body).toBe('orig');
  });
});

describe('deleteNote', () => {
  it('lets the author delete their own non-sensitive note', async () => {
    const doc = fakeDoc({ _id: ID, authorUserId: AUTHOR, visibility: NoteVisibility.INTERNAL });
    h.Note.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await deleteNote(ID, AUTHOR, false);
    expect(doc.deleteOne).toHaveBeenCalledTimes(1);
    expect(h.auditMock).toHaveBeenCalledTimes(1);
  });

  it('forbids an admin from deleting a sensitive note they did not author', async () => {
    const doc = fakeDoc({ _id: ID, authorUserId: AUTHOR, visibility: NoteVisibility.SENSITIVE });
    h.Note.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(deleteNote(ID, OTHER, true))
      .rejects.toMatchObject({ message: expect.stringContaining('sensitive') });
    expect(doc.deleteOne).not.toHaveBeenCalled();
  });

  it('lets the author delete their own sensitive note', async () => {
    const doc = fakeDoc({ _id: ID, authorUserId: AUTHOR, visibility: NoteVisibility.SENSITIVE });
    h.Note.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await deleteNote(ID, AUTHOR, false);
    expect(doc.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('forbids a non-author non-admin from deleting a normal note', async () => {
    const doc = fakeDoc({ _id: ID, authorUserId: AUTHOR, visibility: NoteVisibility.INTERNAL });
    h.Note.findById.mockReturnValue({ exec: vi.fn().mockResolvedValue(doc) });
    await expect(deleteNote(ID, OTHER, false)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
