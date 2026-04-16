// ═══════════════════════════════════════════════════════════
// Safe-mode status — readable by any authenticated user so the
// shadchan UI can disable send buttons. The flag itself is set
// only via env + admin-only settings PATCH.
// ═══════════════════════════════════════════════════════════

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { ok } from '../../utils/response.js';
import { ensureUser } from '../../middleware/permissions.js';
import { getSafeModeStatus } from '../../services/safe-mode/safe-mode.service.js';

export const safeModeRouter = Router();
safeModeRouter.use(requireAuth);

safeModeRouter.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    ensureUser(req.user);
    ok(res, await getSafeModeStatus());
  } catch (e) { next(e); }
});
