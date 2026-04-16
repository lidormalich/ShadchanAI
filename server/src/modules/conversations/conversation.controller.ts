import type { Request, Response, NextFunction } from 'express';
import * as svc from './conversation.service.js';
import { getValidatedQuery, getValidatedParams } from '../../middleware/validate.middleware.js';
import { ok } from '../../utils/response.js';
import { ensureUser, canApproveMatches } from '../../middleware/permissions.js';
import type { ListConversationsQuery, ListMessagesQuery } from './conversation.validator.js';
import type { ChannelRole } from '@shadchanai/shared';

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const q = getValidatedQuery<ListConversationsQuery>(req);
    const { items, meta } = await svc.listConversations(q);
    ok(res, items, meta);
  } catch (e) { next(e); }
}

export async function getHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.getConversationById(id));
  } catch (e) { next(e); }
}

export async function listMessagesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const q = getValidatedQuery<ListMessagesQuery>(req);
    const { items, meta } = await svc.listMessagesForConversation(id, q);
    ok(res, items, meta);
  } catch (e) { next(e); }
}

export async function markReadHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.markConversationRead(id, user.id));
  } catch (e) { next(e); }
}

export async function linkHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.linkConversation(id, req.body as Record<string, string>, user.id));
  } catch (e) { next(e); }
}

export async function assignRoleHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user); // any operator can map; admin not strictly required
    const { id } = getValidatedParams<{ id: string }>(req);
    const { role } = req.body as { role: 'profiles_source' | 'match_sending' | 'ignore' | null };
    ok(res, await svc.assignConversationRole(id, role, user.id));
  } catch (e) { next(e); }
}

export async function chainHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.getChain(id));
  } catch (e) { next(e); }
}

export async function byRoleHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const role = req.params['role'] as ChannelRole;
    const q = getValidatedQuery<ListConversationsQuery>(req);
    const { items, meta } = await svc.listConversationsByChannelRole(role, q);
    ok(res, items, meta);
  } catch (e) { next(e); }
}

export async function sendMessageHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { body } = req.body as { body: string };
    ok(res, await svc.sendMessageInConversation(id, { body, performedBy: user.id }));
  } catch (e) { next(e); }
}
