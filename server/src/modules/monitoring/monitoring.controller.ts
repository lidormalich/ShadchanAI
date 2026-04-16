import type { Request, Response, NextFunction } from 'express';
import { ensureUser, hasRole } from '../../middleware/permissions.js';
import { ForbiddenError } from '../../utils/errors.js';
import { ok } from '../../utils/response.js';
import { buildOverview, buildRecentEvents } from './monitoring.service.js';

// Admin-only gate. This surface exposes cross-tenant counters and
// is never shown to shadchan operators during normal work.
function requireMonitoringAccess(req: Request): void {
  const user = ensureUser(req.user);
  if (!hasRole(user, 'admin')) {
    throw new ForbiddenError('Monitoring is admin-only', 'monitoring_admin_only');
  }
}

export async function overviewHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireMonitoringAccess(req);
    const windowHours = Math.max(1, Math.min(Number(req.query['windowHours']) || 24, 168));
    ok(res, await buildOverview(windowHours));
  } catch (e) { next(e); }
}

export async function eventsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireMonitoringAccess(req);
    const limit = Math.max(10, Math.min(Number(req.query['limit']) || 100, 200));
    ok(res, await buildRecentEvents(limit));
  } catch (e) { next(e); }
}
