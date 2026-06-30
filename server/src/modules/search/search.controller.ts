// ═══════════════════════════════════════════════════════════
// Global search (Phase 5).
//
// Thin HTTP layer — all query + shaping logic lives in
// search.service.ts.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as svc from './search.service.js';
import { ensureUser } from '../../middleware/permissions.js';
import { getValidatedQuery } from '../../middleware/validate.middleware.js';
import { ok } from '../../utils/response.js';
import type { SearchQuery } from './search.validator.js';

export async function searchHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const query = getValidatedQuery<SearchQuery>(req);
    ok(res, await svc.search(query));
  } catch (e) { next(e); }
}
