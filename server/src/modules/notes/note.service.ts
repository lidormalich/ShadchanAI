import { Types } from 'mongoose';
import { AuditActionType, AuditEntityType, NoteVisibility } from '@shadchanai/shared';
import { Note, type INote } from '../../models/index.js';
import { audit } from '../../services/audit.service.js';
import { NotFoundError, ForbiddenError } from '../../utils/errors.js';
import { toSkipLimit, buildSort, makeMeta } from '../../utils/pagination.js';
import type { CreateNoteInput, UpdateNoteInput, ListNotesQuery } from './note.validator.js';

export async function listNotes(
  query: ListNotesQuery,
): Promise<{ items: INote[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  const { skip, limit } = toSkipLimit(query);
  const sort = buildSort(query, 'createdAt');
  const filter: Record<string, unknown> = {
    entityType: query.entityType,
    entityId: new Types.ObjectId(query.entityId),
  };
  if (query.visibility) filter['visibility'] = query.visibility;

  const [items, total] = await Promise.all([
    Note.find(filter).sort(sort).skip(skip).limit(limit).lean().exec(),
    Note.countDocuments(filter).exec(),
  ]);
  return {
    items: items as unknown as INote[],
    total,
    meta: makeMeta(query.page, query.limit, total),
  };
}

export async function getNoteById(id: string): Promise<INote> {
  const doc = await Note.findById(id).exec();
  if (!doc) throw new NotFoundError('Note', id);
  return doc;
}

export async function createNote(input: CreateNoteInput, performedBy: string): Promise<INote> {
  const doc = await Note.create({
    entityType: input.entityType,
    entityId: new Types.ObjectId(input.entityId),
    body: input.body,
    visibility: input.visibility,
    mentions: input.mentions.map((id) => new Types.ObjectId(id)),
    pinned: input.pinned,
    authorUserId: new Types.ObjectId(performedBy),
  });
  await audit({
    entityType: AuditEntityType.NOTE,
    entityId: String(doc._id),
    actionType: AuditActionType.CREATE,
    performedBy,
    after: doc.toObject(),
  });
  return doc;
}

export async function updateNote(
  id: string,
  input: UpdateNoteInput,
  performedBy: string,
  isAdmin: boolean,
): Promise<INote> {
  const doc = await getNoteById(id);
  if (String(doc.authorUserId) !== performedBy && !isAdmin) {
    throw new ForbiddenError('Only the author or an admin can edit this note');
  }
  const before = doc.toObject();
  if (input.body !== undefined) doc.body = input.body;
  if (input.visibility !== undefined) doc.visibility = input.visibility;
  if (input.pinned !== undefined) doc.pinned = input.pinned;
  if (input.mentions !== undefined) {
    doc.mentions = input.mentions.map((m) => new Types.ObjectId(m));
  }
  await doc.save();
  await audit({
    entityType: AuditEntityType.NOTE,
    entityId: id,
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: doc.toObject(),
  });
  return doc;
}

/**
 * Delete a note if policy allows:
 *   - author can delete their own non-sensitive note
 *   - admins can delete any note except sensitive notes they didn't author
 *
 * Even on delete, an audit record is created so the deletion itself is
 * traceable (audit-critical history is never erased).
 */
export async function deleteNote(id: string, performedBy: string, isAdmin: boolean): Promise<void> {
  const doc = await getNoteById(id);
  const isAuthor = String(doc.authorUserId) === performedBy;
  const isSensitive = doc.visibility === NoteVisibility.SENSITIVE;

  if (isSensitive && !isAuthor) {
    throw new ForbiddenError('Only the author may delete a sensitive note');
  }
  if (!isAuthor && !isAdmin) {
    throw new ForbiddenError('Only the author or an admin may delete this note');
  }

  const before = doc.toObject();
  await doc.deleteOne();
  await audit({
    entityType: AuditEntityType.NOTE,
    entityId: id,
    actionType: AuditActionType.DELETE,
    performedBy,
    before,
  });
}
