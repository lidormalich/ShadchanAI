import { z } from 'zod';
import { ChannelRole, ChannelStatus } from '@shadchanai/shared';
import { PaginationQuerySchema } from '../../utils/pagination.js';

export const ListChannelsQuerySchema = PaginationQuerySchema.extend({
  role: z.nativeEnum(ChannelRole).optional(),
  status: z.nativeEnum(ChannelStatus).optional(),
});
export type ListChannelsQuery = z.infer<typeof ListChannelsQuerySchema>;

// Baileys: phoneNumber is unknown until pairing completes; there's no
// Meta phone_number_id and no API token. Only role + display name are
// required at creation.
export const ConnectChannelSchema = z.object({
  channelRole: z.nativeEnum(ChannelRole),
  accountDisplayName: z.string().trim().min(1).max(200),
  phoneNumber: z.string().trim().max(30).optional(),
});

export const ReplaceChannelSchema = z.object({
  newChannel: ConnectChannelSchema,
});

export const DisconnectChannelSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const ChannelIdParamSchema = z.object({
  channelId: z.string().regex(/^ch_[a-f0-9]+$/i),
});

// Role assignment for a specific chat jid on this channel.
// null clears the mapping (back to "unmapped").
export const AssignChatRoleSchema = z.object({
  chatJid: z.string().trim().min(3).max(200),
  chatName: z.string().trim().max(200).optional(),
  chatType: z.enum(['group', 'private']),
  role: z.enum(['profiles_source', 'match_sending', 'ignore']).nullable(),
  // When approving a chat as profiles_source, also retroactively feed the
  // messages that already arrived from it (held back as ignored_unmapped)
  // into the extraction pipeline.
  backfillExisting: z.boolean().optional(),
});

// Body for per-chat actions that only need to identify the chat (backfill
// held-back messages / request WhatsApp history). chatJid carries '@' and
// '.', so it travels in the body rather than the URL.
export const ChatJidBodySchema = z.object({
  chatJid: z.string().trim().min(3).max(200),
});

// Query for previewing a chat's stored messages. chatJid carries '@'
// and '.', but it's a well-formed jid string so it rides in the query.
export const ChatMessagesQuerySchema = z.object({
  chatJid: z.string().trim().min(3).max(200),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const DeleteChannelSchema = z.object({
  // Guard: the operator must confirm the channelId in the body so a
  // bad URL-param typo can't wipe the wrong channel.
  confirmChannelId: z.string().regex(/^ch_[a-f0-9]+$/i),
});

// Body for the admin force-release-lock endpoint. Reason is required
// so the audit trail records WHY ownership was forcibly stolen.
export const ForceReleaseLockSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

// Query for the downtime coverage reports feed (operator banner).
export const CoverageReportsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type CoverageReportsQuery = z.infer<typeof CoverageReportsQuerySchema>;
