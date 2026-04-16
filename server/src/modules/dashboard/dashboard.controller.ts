import type { Request, Response, NextFunction } from 'express';
import { ensureUser } from '../../middleware/permissions.js';
import { getValidatedQuery } from '../../middleware/validate.middleware.js';
import { ok } from '../../utils/response.js';
import { buildDashboardQueue } from './dashboard.service.js';
import type { DashboardQueueQuery } from './dashboard.validator.js';

export async function queueHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const q = getValidatedQuery<DashboardQueueQuery>(req);
    const rows = await buildDashboardQueue({
      ownership: q.ownership,
      limit: q.limit,
      type: q.type,
      currentUserId: user.id,
    });
    ok(res, rows);
  } catch (e) { next(e); }
}
