import type { Request, Response, NextFunction } from 'express';
import * as svc from './note.service.js';
import { getValidatedQuery, getValidatedParams } from '../../middleware/validate.middleware.js';
import { ok, created, noContent } from '../../utils/response.js';
import { ensureUser, hasRole } from '../../middleware/permissions.js';
import type { CreateNoteInput, UpdateNoteInput, ListNotesQuery } from './note.validator.js';

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const q = getValidatedQuery<ListNotesQuery>(req);
    const { items, meta } = await svc.listNotes(q);
    ok(res, items, meta);
  } catch (e) { next(e); }
}

export async function createHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    created(res, await svc.createNote(req.body as CreateNoteInput, user.id));
  } catch (e) { next(e); }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.updateNote(id, req.body as UpdateNoteInput, user.id, hasRole(user, 'admin')));
  } catch (e) { next(e); }
}

export async function deleteHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    await svc.deleteNote(id, user.id, hasRole(user, 'admin'));
    noContent(res);
  } catch (e) { next(e); }
}
