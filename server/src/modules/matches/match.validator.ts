// ═══════════════════════════════════════════════════════════
// ShadchanAI — Match Suggestion Validators
// ═══════════════════════════════════════════════════════════

import { z } from 'zod';
import { MatchSuggestionStatus, MatchType, SourceMode } from '@shadchanai/shared';
import { PaginationQuerySchema } from '../../utils/pagination.js';

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i);

export const ListMatchesQuerySchema = PaginationQuerySchema.extend({
  status: z.nativeEnum(MatchSuggestionStatus).optional(),
  matchType: z.nativeEnum(MatchType).optional(),
  internalCandidateId: ObjectIdString.optional(),
  externalCandidateId: ObjectIdString.optional(),
  isDeferred: z.coerce.boolean().optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
});

export type ListMatchesQuery = z.infer<typeof ListMatchesQuerySchema>;

export const EvaluatePairSchema = z.object({
  internalCandidateId: ObjectIdString,
  externalCandidateId: ObjectIdString,
  mode: z.nativeEnum(SourceMode).default(SourceMode.STRICT),
});

export const CreateManualSuggestionSchema = z.object({
  internalCandidateId: ObjectIdString,
  externalCandidateId: ObjectIdString,
  mode: z.nativeEnum(SourceMode).default(SourceMode.STRICT),
  notes: z.string().max(2000).optional(),
});

export const DeferSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const CloseMatchSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const DeclineSchema = z.object({
  side: z.enum(['a', 'b']),
  reason: z.string().max(500).optional(),
  notes: z.string().max(1000).optional(),
});

export const IdParamSchema = z.object({ id: ObjectIdString });

export const SendProposalSchema = z.object({
  side: z.enum(['a', 'b']),
  // Baileys channelId shape: "ch_" + hex
  channelId: z.string().regex(/^ch_[a-f0-9]+$/i),
  body: z.string().trim().min(1).max(4000),
});
