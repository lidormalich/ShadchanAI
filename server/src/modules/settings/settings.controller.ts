import type { Request, Response, NextFunction } from 'express';
import { ensureUser } from '../../middleware/permissions.js';
import { ok } from '../../utils/response.js';
import { listSettings, upsertSetting } from './settings.service.js';

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    ok(res, await listSettings());
  } catch (e) { next(e); }
}

export async function upsertHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const key = String(req.params['key'] ?? '');
    const { value } = req.body as { value: unknown };
    ok(res, await upsertSetting(key, value, user.id));
  } catch (e) { next(e); }
}
