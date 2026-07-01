import type { Request, Response, NextFunction } from 'express';
import * as svc from './channel.service.js';
import { getValidatedQuery, getValidatedParams } from '../../middleware/validate.middleware.js';
import { ok, created } from '../../utils/response.js';
import { ensureUser, canManageChannels } from '../../middleware/permissions.js';
import type { ListChannelsQuery } from './channel.validator.js';
import type { ConnectChannelInput } from '../../services/whatsapp/whatsapp.types.js';

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const q = getValidatedQuery<ListChannelsQuery>(req);
    const { items, meta } = await svc.listChannels(q);
    ok(res, items, meta);
  } catch (e) { next(e); }
}

export async function getHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    ok(res, await svc.getChannel(channelId));
  } catch (e) { next(e); }
}

export async function connectHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const view = await svc.connect(req.body as ConnectChannelInput, user.id);
    created(res, view);
  } catch (e) { next(e); }
}

export async function reconnectHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    ok(res, await svc.reconnect(channelId, user.id));
  } catch (e) { next(e); }
}

export async function disconnectHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    const { reason } = (req.body as { reason?: string }) ?? {};
    ok(res, await svc.disconnect(channelId, reason, user.id));
  } catch (e) { next(e); }
}

export async function replaceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    const { newChannel } = req.body as { newChannel: ConnectChannelInput };
    ok(res, await svc.replace(channelId, newChannel, user.id));
  } catch (e) { next(e); }
}

export async function chainHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    ok(res, await svc.chain(channelId));
  } catch (e) { next(e); }
}

export async function healthHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    ok(res, await svc.healthSummary());
  } catch (e) { next(e); }
}

// ── Baileys session administration ───────────────────────
// Admin-only. The QR (present only during pending_pairing)
// is returned directly to the admin caller and is NEVER
// included in list/health responses.

export async function sessionStartHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    ok(res, await svc.startSession(channelId, user.id));
  } catch (e) { next(e); }
}

export async function sessionStatusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    const status = svc.sessionStatus(channelId);
    if (!status) {
      res.status(404).json({ success: false, error: { code: 'no_active_session', message: 'No Baileys session is currently running for this channel' } });
      return;
    }
    ok(res, status);
  } catch (e) { next(e); }
}

export async function sessionStopHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    await svc.stopSession(channelId, user.id);
    res.status(204).end();
  } catch (e) { next(e); }
}

export async function sessionLogoutHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    await svc.logoutSession(channelId, user.id);
    res.status(204).end();
  } catch (e) { next(e); }
}

// ── Multi-account admin: sessions overview + lock administration ──

export async function adminSessionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    ok(res, await svc.getAdminSessions());
  } catch (e) { next(e); }
}

export async function adminForceReleaseLockHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    const { reason } = req.body as { reason: string };
    ok(res, await svc.adminForceReleaseLock(channelId, reason, user.id));
  } catch (e) { next(e); }
}

export async function listChatsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    ok(res, await svc.listDiscoveredChats(channelId));
  } catch (e) { next(e); }
}

export async function assignChatRoleHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    const { chatJid, chatName, chatType, role, backfillExisting } = req.body as {
      chatJid: string;
      chatName?: string;
      chatType: 'group' | 'private';
      role: 'profiles_source' | 'match_sending' | 'ignore' | null;
      backfillExisting?: boolean;
    };
    ok(res, await svc.assignChatRole(channelId, chatJid, chatType, role, user.id, chatName, backfillExisting));
  } catch (e) { next(e); }
}

export async function listPendingChatsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    ok(res, await svc.listPendingChats(channelId));
  } catch (e) { next(e); }
}

export async function backfillChatHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    const { chatJid } = req.body as { chatJid: string };
    const enqueued = await svc.backfillChatExtraction(channelId, chatJid, user.id);
    ok(res, { channelId, chatJid, enqueued });
  } catch (e) { next(e); }
}

export async function historySyncHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    const { chatJid } = req.body as { chatJid: string };
    ok(res, await svc.requestChatHistorySync(channelId, chatJid, user.id));
  } catch (e) { next(e); }
}

export async function deleteChannelHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const { channelId } = getValidatedParams<{ channelId: string }>(req);
    const { confirmChannelId, reassignHistoryTo, orphanHistory } = req.body as {
      confirmChannelId: string;
      reassignHistoryTo?: string;
      orphanHistory?: boolean;
    };
    if (confirmChannelId !== channelId) {
      throw new (await import('../../utils/errors.js')).ValidationError(
        'confirmChannelId must match the URL param',
      );
    }
    await svc.deleteChannelSafely(channelId, user.id, { reassignHistoryTo, orphanHistory });
    res.status(204).end();
  } catch (e) { next(e); }
}
