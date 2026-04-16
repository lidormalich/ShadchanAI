import type { Request, Response, NextFunction } from 'express';
import { ensureUser } from '../../middleware/permissions.js';
import { ok } from '../../utils/response.js';
import { getRecentNotifications } from '../../services/notifications/notifications.service.js';

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const limit = Math.min(Number(req.query['limit']) || 30, 100);
    ok(res, getRecentNotifications(limit));
  } catch (e) { next(e); }
}
