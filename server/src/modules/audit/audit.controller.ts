// ═══════════════════════════════════════════════════════════
// Audit query — read-only, scoped by entity (Phase 2).
// Reads from the existing immutable AuditLog collection.
// A full global audit explorer is NOT implemented here —
// only entity-scoped timelines for candidate/match history UIs.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as svc from './audit.service.js';
import { getValidatedQuery } from '../../middleware/validate.middleware.js';
import { ok } from '../../utils/response.js';
import { ensureUser } from '../../middleware/permissions.js';
import type { ListAuditLogsQuery } from './audit.validator.js';

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const q = getValidatedQuery<ListAuditLogsQuery>(req);
    const { items, meta } = await svc.listAuditLogs(q);
    ok(res, items, meta);
  } catch (e) { next(e); }
}
