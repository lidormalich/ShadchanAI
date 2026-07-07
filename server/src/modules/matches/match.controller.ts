// ═══════════════════════════════════════════════════════════
// ShadchanAI — Match Suggestion Controller
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as svc from './match.service.js';
import { checkPairFromText } from './sandbox.service.js';
import type { SandboxCheckBody } from './match.validator.js';
import * as scanSvc from '../../services/matching/match-scan.service.js';
import {
  startSemanticBackfill,
  getSemanticBackfillState,
} from '../../services/embedding/semantic-backfill.service.js';
import { getValidatedQuery, getValidatedParams } from '../../middleware/validate.middleware.js';
import { ok, created } from '../../utils/response.js';
import { ensureUser, canApproveMatches } from '../../middleware/permissions.js';
import type { ListMatchesQuery } from './match.validator.js';
import type { SourceMode } from '@shadchanai/shared';
import type { ScoreDirection, PairScoreBucket } from './pair-score.model.js';

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const q = getValidatedQuery<ListMatchesQuery>(req);
    const { items, meta } = await svc.listMatches(q, user.id);
    ok(res, items, meta);
  } catch (e) { next(e); }
}

export async function getHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.getMatchById(id));
  } catch (e) { next(e); }
}

export async function evaluateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { internalCandidateId, externalCandidateId, mode } = req.body as {
      internalCandidateId: string;
      externalCandidateId: string;
      mode: SourceMode;
    };
    const result = await svc.evaluatePair(internalCandidateId, externalCandidateId, mode);
    ok(res, result);
  } catch (e) { next(e); }
}

// Ad-hoc "בדוק מועמדים": compatibility check between two pasted free-text
// people. No candidates are saved; the result is computed and thrown away.
export async function sandboxCheckHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { sideA, sideB, mode } = req.body as SandboxCheckBody;
    const result = await checkPairFromText({ sideA, sideB, mode, userId: user.id });
    ok(res, result);
  } catch (e) { next(e); }
}

export async function findForInternalHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const mode = ((req.query['mode'] as SourceMode | undefined) ?? 'strict') as SourceMode;
    // No `limit` query param → return every eligible scored match; the client
    // paginates client-side. Callers can still pass `limit` to cap the response.
    const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
    const items = await svc.findMatchesForInternal(id, mode, limit);
    ok(res, items);
  } catch (e) { next(e); }
}

export async function findBlockedForInternalHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const mode = ((req.query['mode'] as SourceMode | undefined) ?? 'strict') as SourceMode;
    const limit = req.query['limit'] ? Number(req.query['limit']) : 50;
    const items = await svc.findBlockedForInternal(id, mode, limit);
    ok(res, items);
  } catch (e) { next(e); }
}

export async function forceSuggestionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const { internalCandidateId, externalCandidateId, mode, justification } =
      req.body as { internalCandidateId: string; externalCandidateId: string; mode: SourceMode; justification: string };
    const doc = await svc.forceCreateSuggestion(internalCandidateId, externalCandidateId, mode, justification, user.id);
    created(res, doc);
  } catch (e) { next(e); }
}

export async function createManualHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const { internalCandidateId, externalCandidateId, mode } = req.body as {
      internalCandidateId: string;
      externalCandidateId: string;
      mode: SourceMode;
    };
    const doc = await svc.createManualSuggestion(internalCandidateId, externalCandidateId, mode, user.id);
    created(res, doc);
  } catch (e) { next(e); }
}

// ── Incremental scan ─────────────────────────────────────

export async function scanHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const rawMode = (req.body?.mode ?? 'missing') as string;
    const mode = (['missing', 'incremental', 'full'].includes(rawMode) ? rawMode : 'missing') as 'missing' | 'incremental' | 'full';
    const result = await scanSvc.startScan({
      trigger: 'manual',
      performedBy: user.id,
      mode,
      createSuggestion: svc.createManualSuggestion,
    });
    ok(res, result);
  } catch (e) { next(e); }
}

export async function scanStateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    ok(res, await scanSvc.getScanState());
  } catch (e) { next(e); }
}

export async function scanResultsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const q = req.query;
    const items = await scanSvc.listScanResults({
      direction: q['direction'] as ScoreDirection | undefined,
      eligibleOnly: q['eligibleOnly'] === 'true',
      autoCreated: q['autoCreated'] === undefined ? undefined : q['autoCreated'] === 'true',
      bucket: q['bucket'] as PairScoreBucket | undefined,
      minScore: q['minScore'] !== undefined ? Number(q['minScore']) : undefined,
      limit: q['limit'] !== undefined ? Number(q['limit']) : undefined,
      view: ['all', 'review_later', 'rejected'].includes(q['view'] as string)
        ? (q['view'] as 'all' | 'review_later' | 'rejected')
        : 'inbox',
    });
    ok(res, items);
  } catch (e) { next(e); }
}

// ── Semantic backfill ("סרוק עכשיו" in the הצעה חכמה tab) ──

export async function semanticBackfillHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    // force=true sweeps ALL active candidates (not just missing/stale
    // modelId) — the "סריקה מאולצת" for profiles that never got vectors.
    const force = (req.body as { force?: unknown } | undefined)?.force === true;
    ok(res, await startSemanticBackfill({ force }));
  } catch (e) { next(e); }
}

export async function semanticBackfillStateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    ok(res, getSemanticBackfillState());
  } catch (e) { next(e); }
}

export async function approveHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const reason = typeof (req.body as { reason?: unknown } | undefined)?.reason === 'string'
      ? (req.body as { reason: string }).reason
      : undefined;
    ok(res, await svc.approveSuggestion(id, user.id, user, reason));
  } catch (e) { next(e); }
}

export async function declineHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { side, reason, notes } = req.body as { side: 'a' | 'b'; reason?: string; notes?: string };
    ok(res, await svc.declineSuggestion(id, side, reason, notes, user.id, user));
  } catch (e) { next(e); }
}

export async function deferHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { reason } = req.body as { reason: string };
    ok(res, await svc.deferSuggestion(id, reason, user.id, user));
  } catch (e) { next(e); }
}

export async function reopenDeferredHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.reopenFromDeferred(id, user.id, user));
  } catch (e) { next(e); }
}

export async function markDatingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const reason = typeof (req.body as { reason?: unknown } | undefined)?.reason === 'string'
      ? (req.body as { reason: string }).reason
      : undefined;
    ok(res, await svc.markMatchDating(id, user.id, user, reason));
  } catch (e) { next(e); }
}

export async function closeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { reason } = req.body as { reason: string };
    ok(res, await svc.closeSuggestion(id, reason, user.id, user));
  } catch (e) { next(e); }
}

export async function explanationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.getExplanationPayload(id));
  } catch (e) { next(e); }
}

// Persisted, staleness-aware AI explanation. Returns the stored
// explanation untouched when nothing scoring-relevant changed; otherwise
// regenerates and reports which inputs changed.
export async function explainHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const force = req.body?.force === true;
    ok(res, await svc.explainMatchSuggestion(id, user, { force }));
  } catch (e) { next(e); }
}

export async function sendPreviewHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.previewSendReadiness(id));
  } catch (e) { next(e); }
}

export async function acknowledgeResponseHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { side } = req.body as { side: 'a' | 'b' };
    ok(res, await svc.acknowledgeResponse(id, side, user.id));
  } catch (e) { next(e); }
}

export async function saveDraftHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { side, body, source } = req.body as { side: 'a' | 'b'; body: string; source?: 'ai' | 'manual' };
    const doc = await svc.saveDraft(id, side, body, user.id, source ?? 'manual', user);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function sendProposalHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canApproveMatches(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { side, channelId, body } = req.body as { side: 'a' | 'b'; channelId: string; body: string };
    const result = await svc.sendProposal(id, {
      side, channelId, body, performedBy: user.id, actor: user,
    });
    ok(res, result);
  } catch (e) { next(e); }
}
