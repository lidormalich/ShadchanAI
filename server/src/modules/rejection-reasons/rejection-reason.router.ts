// ═══════════════════════════════════════════════════════════
// RejectionReason Router — read-only view of the reasons bank.
//
// The bank is written implicitly by the AI-explain flow (see
// pair-review.controller). This router only exposes it for
// inspection / analytics ("most common reasons a pair didn't match").
// ═══════════════════════════════════════════════════════════

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { ensureUser } from '../../middleware/permissions.js';
import { ok } from '../../utils/response.js';
import { listReasons } from './rejection-reason.service.js';

export const rejectionReasonRouter = Router();
rejectionReasonRouter.use(requireAuth);

rejectionReasonRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureUser(req.user);
    const category = typeof req.query['category'] === 'string' ? req.query['category'] : undefined;
    const limit = req.query['limit'] !== undefined ? Number(req.query['limit']) : undefined;
    ok(res, await listReasons({ category, limit }));
  } catch (e) { next(e); }
});
