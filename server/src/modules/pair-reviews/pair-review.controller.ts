import type { Request, Response, NextFunction } from 'express';
import * as svc from './pair-review.service.js';
import { ok, created } from '../../utils/response.js';
import { ensureUser } from '../../middleware/permissions.js';
import { getValidatedParams } from '../../middleware/validate.middleware.js';
import type { UpsertPairReviewBody } from './pair-review.validator.js';

export async function listForInternalHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { internalId } = getValidatedParams<{ internalId: string }>(req);
    await svc.assertOwnsInternal(internalId, user);
    const items = await svc.listForInternal(internalId);
    ok(res, items);
  } catch (e) { next(e); }
}

export async function getForPairHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { internalId, externalId } = getValidatedParams<{
      internalId: string; externalId: string;
    }>(req);
    await svc.assertOwnsInternal(internalId, user);
    const doc = await svc.getForPair(internalId, externalId);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function upsertReviewHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { internalId, externalId } = getValidatedParams<{
      internalId: string; externalId: string;
    }>(req);
    await svc.assertOwnsInternal(internalId, user);
    const body = req.body as UpsertPairReviewBody;
    const doc = await svc.upsertReview({
      internalCandidateId: internalId,
      externalCandidateId: externalId,
      manualStatus: body.manualStatus,
      operatorReason: body.operatorReason,
      outcomeReason: body.outcomeReason,
      matchSuggestionId: body.matchSuggestionId,
      performedBy: user.id,
    });
    created(res, doc);
  } catch (e) { next(e); }
}

export async function clearReviewHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { internalId, externalId } = getValidatedParams<{
      internalId: string; externalId: string;
    }>(req);
    await svc.assertOwnsInternal(internalId, user);
    await svc.clearReview(internalId, externalId, user.id);
    ok(res, { cleared: true });
  } catch (e) { next(e); }
}

// ── AI explanation (advisory only) ──────────────────────────
//
// All model access, ownership, scoring fallback, reasons-bank
// ingestion, and persistence live in the service. The controller
// just resolves params + the authenticated user and shapes the
// HTTP response.
export async function explainAIHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { internalId, externalId } = getValidatedParams<{
      internalId: string; externalId: string;
    }>(req);

    const { pairReview, ai, metadata } = await svc.explainPairWithAI(
      internalId, externalId, user,
    );

    ok(res, { pairReview, ai, metadata });
  } catch (e) { next(e); }
}
