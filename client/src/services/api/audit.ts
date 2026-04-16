import { api } from './client';

export interface AuditLogEntry {
  _id: string;
  entityType: string;
  entityId: string;
  actionType: string;
  performedBy: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export const auditApi = {
  list: (query: { entityType: string; entityId: string; limit?: number; page?: number; actionType?: string }) =>
    api.get<AuditLogEntry[]>('/audit-logs', query),
};
