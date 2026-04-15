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
