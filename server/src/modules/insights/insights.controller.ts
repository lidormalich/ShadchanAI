// ═══════════════════════════════════════════════════════════
// Insights summary (Phase 5).
//
// Thin HTTP layer — all aggregation/funnel logic lives in
// insights.service.ts.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as svc from './insights.service.js';
import { ensureUser } from '../../middleware/permissions.js';
import { ok } from '../../utils/response.js';

export async function summaryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    ok(res, await svc.getSummary());
  } catch (e) { next(e); }
}
