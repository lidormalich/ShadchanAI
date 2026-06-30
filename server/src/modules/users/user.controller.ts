// ═══════════════════════════════════════════════════════════
// Minimal users directory — Phase 3.
// Returns active users for owner display and task assignment.
// Full team admin / user CRUD is intentionally out of scope.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as svc from './user.service.js';
import { ensureUser } from '../../middleware/permissions.js';
import { ok } from '../../utils/response.js';

export async function listHandler(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(_req.user);
    ok(res, await svc.listActiveUsers());
  } catch (e) { next(e); }
}
