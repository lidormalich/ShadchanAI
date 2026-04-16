import { z } from 'zod';
import { AuditEntityType, AuditActionType } from '@shadchanai/shared';
import { PaginationQuerySchema } from '../../utils/pagination.js';

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i);

export const ListAuditLogsQuerySchema = PaginationQuerySchema.extend({
  entityType: z.nativeEnum(AuditEntityType),
  entityId: ObjectIdString,
  actionType: z.nativeEnum(AuditActionType).optional(),
});

export type ListAuditLogsQuery = z.infer<typeof ListAuditLogsQuerySchema>;
