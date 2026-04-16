import { z } from 'zod';

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().positive().max(50).default(12),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;
