import type { Request, Response, NextFunction } from 'express';
import * as svc from './task.service.js';
import { getValidatedQuery, getValidatedParams } from '../../middleware/validate.middleware.js';
import { ok, created } from '../../utils/response.js';
import { ensureUser } from '../../middleware/permissions.js';
import type { CreateTaskInput, UpdateTaskInput, ListTasksQuery } from './task.validator.js';

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const q = getValidatedQuery<ListTasksQuery>(req);
    const { items, meta } = await svc.listTasks(q);
    ok(res, items, meta);
  } catch (e) { next(e); }
}

export async function getHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.getTaskById(id));
  } catch (e) { next(e); }
}

export async function createHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    created(res, await svc.createTask(req.body as CreateTaskInput, user.id));
  } catch (e) { next(e); }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.updateTask(id, req.body as UpdateTaskInput, user.id));
  } catch (e) { next(e); }
}

export async function completeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { completionNote } = (req.body as { completionNote?: string }) ?? {};
    ok(res, await svc.completeTask(id, completionNote, user.id));
  } catch (e) { next(e); }
}

export async function reassignHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { assignedTo } = req.body as { assignedTo: string };
    ok(res, await svc.reassignTask(id, assignedTo, user.id));
  } catch (e) { next(e); }
}
