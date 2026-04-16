// ═══════════════════════════════════════════════════════════
// Audit query — read-only, scoped by entity (Phase 2).
// Reads from the existing immutable AuditLog collection.
// A full global audit explorer is NOT implemented here —
// only entity-scoped timelines for candidate/match history UIs.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { AuditLog } from '../../models/index.js';
import { getValidatedQuery } from '../../middleware/validate.middleware.js';
import { ok } from '../../utils/response.js';
import { ensureUser } from '../../middleware/permissions.js';
import { toSkipLimit, buildSort, makeMeta } from '../../utils/pagination.js';
import type { ListAuditLogsQuery } from './audit.validator.js';

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const q = getValidatedQuery<ListAuditLogsQuery>(req);
    const { skip, limit } = toSkipLimit(q);
    const sort = buildSort(q, 'createdAt');

    const filter: Record<string, unknown> = {
      entityType: q.entityType,
      entityId: new Types.ObjectId(q.entityId),
    };
    if (q.actionType) filter['actionType'] = q.actionType;

    const [items, total] = await Promise.all([
      AuditLog.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        // trim heavy snapshot payloads for timeline display
        .select('entityType entityId actionType performedBy metadata createdAt')
        .lean()
        .exec(),
      AuditLog.countDocuments(filter).exec(),
    ]);

    ok(res, items, makeMeta(q.page, q.limit, total));
  } catch (e) { next(e); }
}
