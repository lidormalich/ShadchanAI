import { Router } from 'express';
import * as ctrl from './channel.controller.js';
import {
  ListChannelsQuerySchema,
  ConnectChannelSchema,
  ReplaceChannelSchema,
  DisconnectChannelSchema,
  ChannelIdParamSchema,
  AssignChatRoleSchema,
  DeleteChannelSchema,
  ForceReleaseLockSchema,
} from './channel.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const channelRouter = Router();
channelRouter.use(requireAuth);

channelRouter.get('/', validate({ query: ListChannelsQuerySchema }), ctrl.listHandler);
channelRouter.get('/health', ctrl.healthHandler);
// Multi-account admin overview: per-channel session + lock state.
// Operators use this to diagnose channel_skipped_lock_held situations.
channelRouter.get('/sessions/admin', ctrl.adminSessionsHandler);
channelRouter.get('/:channelId', validate({ params: ChannelIdParamSchema }), ctrl.getHandler);
channelRouter.get('/:channelId/chain', validate({ params: ChannelIdParamSchema }), ctrl.chainHandler);

channelRouter.post('/', validate({ body: ConnectChannelSchema }), ctrl.connectHandler);
channelRouter.post('/:channelId/reconnect', validate({ params: ChannelIdParamSchema }), ctrl.reconnectHandler);
channelRouter.post('/:channelId/disconnect', validate({ params: ChannelIdParamSchema, body: DisconnectChannelSchema }), ctrl.disconnectHandler);
channelRouter.post('/:channelId/replace', validate({ params: ChannelIdParamSchema, body: ReplaceChannelSchema }), ctrl.replaceHandler);

// ── Baileys session lifecycle (admin-only) ───────────────
channelRouter.post('/:channelId/session/start',  validate({ params: ChannelIdParamSchema }), ctrl.sessionStartHandler);
channelRouter.get ('/:channelId/session/status', validate({ params: ChannelIdParamSchema }), ctrl.sessionStatusHandler);
channelRouter.post('/:channelId/session/stop',   validate({ params: ChannelIdParamSchema }), ctrl.sessionStopHandler);
channelRouter.post('/:channelId/session/logout', validate({ params: ChannelIdParamSchema }), ctrl.sessionLogoutHandler);

// Admin override: forcibly release a channel's persisted lock.
// Refused while a live in-process Baileys client still holds the
// channel — operator must stop/logout first. Reason is required and
// every call is audited.
channelRouter.post(
  '/:channelId/lock/release',
  validate({ params: ChannelIdParamSchema, body: ForceReleaseLockSchema }),
  ctrl.adminForceReleaseLockHandler,
);

// ── Pre-pilot discovery + mapping + safe delete ──────────
channelRouter.get('/:channelId/chats', validate({ params: ChannelIdParamSchema }), ctrl.listChatsHandler);
channelRouter.patch('/:channelId/chats/role', validate({ params: ChannelIdParamSchema, body: AssignChatRoleSchema }), ctrl.assignChatRoleHandler);
// Using POST (not DELETE) so the operator-confirmation body is
// trivially accepted by the standard API client. The body still
// requires confirmChannelId to match — the guard is unchanged.
channelRouter.post('/:channelId/delete', validate({ params: ChannelIdParamSchema, body: DeleteChannelSchema }), ctrl.deleteChannelHandler);
