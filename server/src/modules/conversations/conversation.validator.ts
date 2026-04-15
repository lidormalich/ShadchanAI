import { z } from 'zod';
import { ChannelRole, ConversationPurpose } from '@shadchanai/shared';
import { PaginationQuerySchema } from '../../utils/pagination.js';

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i);

export const ListConversationsQuerySchema = PaginationQuerySchema.extend({
  channelId: z.string().optional(),
  channelRole: z.nativeEnum(ChannelRole).optional(),
  purpose: z.nativeEnum(ConversationPurpose).optional(),
  needsAction: z.coerce.boolean().optional(),
  hasUnread: z.coerce.boolean().optional(),
  internalCandidateId: ObjectIdString.optional(),
  externalCandidateId: ObjectIdString.optional(),
  matchSuggestionId: ObjectIdString.optional(),
});

export type ListConversationsQuery = z.infer<typeof ListConversationsQuerySchema>;

export const ListMessagesQuerySchema = PaginationQuerySchema.extend({
  before: z.coerce.date().optional(),
  after: z.coerce.date().optional(),
});

export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;

export const LinkConversationSchema = z.object({
  internalCandidateId: ObjectIdString.optional(),
  externalCandidateId: ObjectIdString.optional(),
  matchSuggestionId: ObjectIdString.optional(),
}).refine(
  (d) => Boolean(d.internalCandidateId || d.externalCandidateId || d.matchSuggestionId),
  { message: 'At least one link target is required' },
);

export const IdParamSchema = z.object({ id: ObjectIdString });

export const SendConvoMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});
