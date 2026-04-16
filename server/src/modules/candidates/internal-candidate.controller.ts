// ═══════════════════════════════════════════════════════════
// ShadchanAI — Internal Candidate Controller
//
// Thin — parses input, delegates to service, formats envelope.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as svc from './internal-candidate.service.js';
import { getValidatedQuery, getValidatedParams } from '../../middleware/validate.middleware.js';
import { ok, created, noContent } from '../../utils/response.js';
import { ensureUser, canWriteCandidates } from '../../middleware/permissions.js';
import type {
  CreateInternalCandidateInput,
  UpdateInternalCandidateInput,
  ListInternalCandidatesQuery,
} from './internal-candidate.validator.js';
import { PaginationQuerySchema } from '../../utils/pagination.js';

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const q = getValidatedQuery<ListInternalCandidatesQuery>(req);
    const { items, meta } = await svc.listInternalCandidates(q, user.id);
    ok(res, items, meta);
  } catch (e) { next(e); }
}

export async function getHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const doc = await svc.getInternalCandidateById(id);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function createHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const doc = await svc.createInternalCandidate(req.body as CreateInternalCandidateInput, user.id);
    created(res, doc);
  } catch (e) { next(e); }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const doc = await svc.updateInternalCandidate(id, req.body as UpdateInternalCandidateInput, user.id, user);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function archiveHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    await svc.archiveInternalCandidate(id, user.id, user);
    noContent(res);
  } catch (e) { next(e); }
}

export async function closeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { reason, note } = req.body as { reason: string; note?: string };
    const doc = await svc.closeInternalCandidate(id, reason, note, user.id, user);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function markDatingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { partnerCandidateId, sourceMatchId } = req.body as {
      partnerCandidateId: string;
      sourceMatchId?: string;
    };
    const doc = await svc.markInternalCandidateDating(id, partnerCandidateId, sourceMatchId, user.id, user);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function reopenHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { fromDatingMatchId, reason, note } = req.body as {
      fromDatingMatchId?: string;
      reason: string;
      note?: string;
    };
    const doc = await svc.reopenInternalCandidate(id, fromDatingMatchId, reason, note, user.id, user);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function suggestionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const q = PaginationQuerySchema.parse(req.query);
    const { items, meta } = await svc.getCandidateSuggestions(id, q);
    ok(res, items, meta);
  } catch (e) { next(e); }
}

export async function conversationsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const items = await svc.getCandidateConversations(id);
    ok(res, items);
  } catch (e) { next(e); }
}

export async function readinessHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const details = await svc.getCandidateReadiness(id);
    ok(res, details);
  } catch (e) { next(e); }
}
