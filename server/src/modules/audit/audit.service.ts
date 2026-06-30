// ═══════════════════════════════════════════════════════════
// Audit query service — read-only, scoped by entity (Phase 2).
// Reads from the existing immutable AuditLog collection.
// NOTE: this is the module's READ service — separate from the
// audit-WRITE helper at services/audit.service.ts.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { AuditLog, type IAuditLog } from '../../models/index.js';
import { toSkipLimit, buildSort, makeMeta } from '../../utils/pagination.js';
import type { ListAuditLogsQuery } from './audit.validator.js';

export async function listAuditLogs(
  query: ListAuditLogsQuery,
): Promise<{ items: IAuditLog[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  const { skip, limit } = toSkipLimit(query);
  const sort = buildSort(query, 'createdAt');

  const filter: Record<string, unknown> = {
    entityType: query.entityType,
    entityId: new Types.ObjectId(query.entityId),
  };
  if (query.actionType) filter['actionType'] = query.actionType;

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

  return {
    items: items as unknown as IAuditLog[],
    total,
    meta: makeMeta(query.page, query.limit, total),
  };
}
