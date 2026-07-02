// ═══════════════════════════════════════════════════════════
// ShadchanAI — External Candidate Controller
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as svc from './external-candidate.service.js';
import { getValidatedQuery, getValidatedParams } from '../../middleware/validate.middleware.js';
import { ok, created, noContent } from '../../utils/response.js';
import { ensureUser, canWriteCandidates } from '../../middleware/permissions.js';
import type {
  CreateExternalCandidateInput,
  UpdateExternalCandidateInput,
  ListExternalCandidatesQuery,
} from './external-candidate.validator.js';

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const q = getValidatedQuery<ListExternalCandidatesQuery>(req);
    const { items, meta } = await svc.listExternalCandidates(q, user.id);
    ok(res, items, meta);
  } catch (e) { next(e); }
}

export async function getHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const doc = await svc.getExternalCandidateById(id);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function createHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const doc = await svc.createExternalCandidate(req.body as CreateExternalCandidateInput, user.id);
    created(res, doc);
  } catch (e) { next(e); }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const doc = await svc.updateExternalCandidate(id, req.body as UpdateExternalCandidateInput, user.id, user);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function archiveHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    await svc.archiveExternalCandidate(id, user.id, user);
    noContent(res);
  } catch (e) { next(e); }
}

export async function shareCardHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const doc = await svc.updateShareCard(id, req.body as Record<string, unknown>, user.id, user);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function availabilityHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { availabilityStatus, staleReason, confirmAvailable } = req.body as {
      availabilityStatus: string;
      staleReason?: string;
      confirmAvailable?: boolean;
    };
    const doc = await svc.updateAvailability(id, availabilityStatus, staleReason, confirmAvailable, user.id, user);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function sourceCardHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const card = await svc.getExternalSourceCard(id);
    ok(res, card);
  } catch (e) { next(e); }
}

export async function matchingInternalsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { mode, limit } = getValidatedQuery<{ mode: 'strict' | 'discovery'; limit: number }>(req);
    const items = await svc.findMatchingInternals(id, mode, limit);
    ok(res, items);
  } catch (e) { next(e); }
}
