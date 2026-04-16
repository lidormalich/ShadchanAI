import { z } from 'zod';

export const DashboardQueueQuerySchema = z.object({
  ownership: z.enum(['mine', 'team', 'all']).default('mine'),
  limit: z.coerce.number().int().positive().max(200).default(50),
  // Optional category filter; when absent every category is included.
  type: z.enum([
    'needs_review',
    'awaiting_response',
    'new_response',
    'inbound_action',
    'overdue_task',
    'high_potential_draft',
    'deferred_recheck',
  ]).optional(),
});

export type DashboardQueueQuery = z.infer<typeof DashboardQueueQuerySchema>;
