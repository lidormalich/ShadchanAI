import { z } from 'zod';
import { ChannelRole, ConversationPurpose } from '@shadchanai/shared';
import { PaginationQuerySchema } from '../../utils/pagination.js';
import { optionalBooleanString } from '../../utils/zod-bool.js';

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i);

export const ListConversationsQuerySchema = PaginationQuerySchema.extend({
  channelId: z.string().optional(),
  channelRole: z.nativeEnum(ChannelRole).optional(),
  purpose: z.nativeEnum(ConversationPurpose).optional(),
  needsAction: optionalBooleanString(),
  hasUnread: optionalBooleanString(),
  internalCandidateId: ObjectIdString.optional(),
  externalCandidateId: ObjectIdString.optional(),
  matchSuggestionId: ObjectIdString.optional(),
  // 'unassigned' surfaces conversations with no explicit role yet —
  // the mapping UI uses this filter to find new chats to map.
  assignedRole: z.enum(['profiles_source', 'match_sending', 'ignore', 'unassigned']).optional(),
});

export type ListConversationsQuery = z.infer<typeof ListConversationsQuerySchema>;

export const AssignRoleSchema = z.object({
  // null clears the assignment (back to "unassigned").
  role: z.enum(['profiles_source', 'match_sending', 'ignore']).nullable(),
});

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
