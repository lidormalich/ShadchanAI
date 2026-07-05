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
import { getCandidateInsight, rebuildCandidateInsight } from '../../services/ai/candidate-learning.service.js';
import { getSemanticMatchesForInternal } from '../../services/embedding/semantic-match.service.js';
import { env } from '../../config/env.js';
import { buildPublicPhotoUrl } from '../../services/storage/candidate-photo.service.js';

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

export async function semanticMatchesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const rawLimit = Number(req.query['limit']);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : undefined;
    ok(res, await getSemanticMatchesForInternal(id, limit));
  } catch (e) { next(e); }
}

export async function sourceCardHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const card = await svc.getInternalSourceCard(id);
    // The client builds the "לכרטיס במערכת" link from this base — it must point
    // at the public deployment, not the operator's localhost (same rule as the
    // photo share link).
    const appBaseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`;
    ok(res, { ...card, appBaseUrl });
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

const PHOTO_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export async function uploadPhotoHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const ext = PHOTO_EXT_BY_MIME[req.header('content-type')?.split(';')[0]?.trim() ?? ''];
    const body = req.body as Buffer;
    if (!ext || !Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({
        success: false,
        error: { code: 'invalid_image', message: 'נדרשת תמונה בפורמט JPG / PNG / WEBP' },
      });
      return;
    }
    const doc = await svc.setInternalCandidatePhoto(id, body, ext);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function removePhotoHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const doc = await svc.removeInternalCandidatePhoto(id);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function photoShareLinkHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const token = await svc.ensureInternalPhotoShareToken(id);
    const base = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`;
    ok(res, { url: buildPublicPhotoUrl(base, token), token });
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

// ── Learned insight (candidate learning agent) ─────────────

export async function insightHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await getCandidateInsight(id));
  } catch (e) { next(e); }
}

export async function rebuildInsightHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const doc = await rebuildCandidateInsight(id);
    ok(res, doc ?? { rebuilt: false, reason: 'no_suggestion_history' });
  } catch (e) { next(e); }
}

// ── Compatibility workspace ──────────────────────────────────
//
// Returns the full operator board: suitable / weak / blocked /
// forced / historical buckets, with deterministic explanations and
// any operator review overlay. Engine is the source of truth — the
// review layer is non-mutating overlay.
import { buildBoardForInternal, checkPair } from '../../services/compatibility/compatibility.service.js';
import type { SourceMode } from '@shadchanai/shared';

export async function compatibilityBoardHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const mode = ((req.query['mode'] as SourceMode | undefined) ?? 'strict') as SourceMode;
    const limit = req.query['limit'] ? Number(req.query['limit']) : 200;
    const board = await buildBoardForInternal(id, mode, { externalLimit: limit });
    ok(res, board);
  } catch (e) { next(e); }
}

export async function pairCheckHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { externalCandidateId, mode } = req.body as {
      externalCandidateId: string;
      mode?: SourceMode;
    };
    const result = await checkPair(id, externalCandidateId, mode ?? 'strict');
    ok(res, result);
  } catch (e) { next(e); }
}
