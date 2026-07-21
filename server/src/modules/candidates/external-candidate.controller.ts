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
import { env } from '../../config/env.js';
import { buildPublicPhotoUrl } from '../../services/storage/candidate-photo.service.js';

const PHOTO_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

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
    const doc = await svc.setExternalCandidatePhoto(id, body, ext);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function removePhotoHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const doc = await svc.removeExternalCandidatePhoto(id);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function photoShareLinkHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const token = await svc.ensureExternalPhotoShareToken(id);
    const base = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`;
    ok(res, { url: buildPublicPhotoUrl(base, token), token });
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

export async function detailsCompletedHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { completed } = req.body as { completed?: boolean };
    const doc = await svc.setDetailsCompleted(id, completed ?? true, user.id, user);
    ok(res, doc);
  } catch (e) { next(e); }
}

export async function sourceCardHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const card = await svc.getExternalSourceCard(id);
    // The client builds the "לכרטיס במערכת" link from this base — it must point
    // at the public deployment, not the operator's localhost (same rule as the
    // photo share link above).
    const appBaseUrl = env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`;
    ok(res, { ...card, appBaseUrl });
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

export async function learningsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);
    const { id } = getValidatedParams<{ id: string }>(req);
    ok(res, await svc.getExternalCandidateLearnings(id));
  } catch (e) { next(e); }
}

export async function addLearningHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id } = getValidatedParams<{ id: string }>(req);
    const { text } = req.body as { text: string };
    ok(res, await svc.addExternalLearning(id, text, user.id, user));
  } catch (e) { next(e); }
}

export async function removeLearningHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canWriteCandidates(user);
    const { id, learningId } = getValidatedParams<{ id: string; learningId: string }>(req);
    ok(res, await svc.removeExternalLearning(id, learningId, user.id, user));
  } catch (e) { next(e); }
}
