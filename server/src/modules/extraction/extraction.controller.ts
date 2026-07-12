// ═══════════════════════════════════════════════════════════
// ShadchanAI — Extraction API
//
// Admin-facing endpoints for the profile-extraction pipeline:
//
//   POST /api/extraction/messages/:messageId/run
//     Synchronously (re-)runs extraction on one message and returns
//     the outcome. Used by the "עבד מחדש" button on a message bubble.
//
//   GET  /api/extraction/review-queue
//     Messages sitting in extraction.status=needs_review with the
//     extracted candidate skeleton — for the human reviewer UI.
//
//   POST /api/extraction/messages/:messageId/approve
//     Operator approves the pending extraction → creates the
//     ExternalCandidate from the last extraction attempt's fields.
//
//   POST /api/extraction/messages/:messageId/reject
//     Operator marks the message as NOT a profile (stops the pipeline
//     from re-queueing it).
//
// Thin HTTP layer — all model access & business logic lives in
// extraction.service.ts.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as svc from './extraction.service.js';
import * as cardLabels from './card-label.service.js';
import { ensureUser, canManageChannels } from '../../middleware/permissions.js';
import { ok } from '../../utils/response.js';

// ── Synchronous manual (re-)run ──────────────────────────

export async function runHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const messageId = String(req.params['messageId'] ?? '');
    ok(res, await svc.runExtraction(messageId));
  } catch (e) { next(e); }
}

// ── Review queue ─────────────────────────────────────────

export async function reviewQueueHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    ok(res, await svc.listReviewQueue(Number(req.query['limit'])));
  } catch (e) { next(e); }
}

// ── Failed queue (extractions that fell) ─────────────────

export async function failedQueueHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    ok(res, await svc.listFailedQueue(Number(req.query['limit'])));
  } catch (e) { next(e); }
}

export async function requeueHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const messageId = String(req.params['messageId'] ?? '');
    ok(res, await svc.requeueExtraction(messageId));
  } catch (e) { next(e); }
}

export async function requeueAllFailedHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    ok(res, await svc.requeueAllFailed());
  } catch (e) { next(e); }
}

export async function reprocessNeedsReviewHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    ok(res, await svc.reprocessNeedsReview());
  } catch (e) { next(e); }
}

// ── Ingestion log (what arrived & how it was routed) ─────

export async function ingestionLogHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const decisionParam = String(req.query['decision'] ?? 'ignored');
    ok(res, await svc.listIngestionLog(Number(req.query['limit']), decisionParam));
  } catch (e) { next(e); }
}

// ── Approve (create candidate from last extraction) ──────

export async function approveHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const messageId = String(req.params['messageId'] ?? '');
    const body = req.body as { profile?: Record<string, unknown>; linkToCandidateId?: string } | undefined;
    ok(res, await svc.approveExtraction(messageId, body?.profile, user.id, {
      linkToCandidateId: typeof body?.linkToCandidateId === 'string' ? body.linkToCandidateId : undefined,
    }));
  } catch (e) { next(e); }
}

// ── Refresh all ("רענן כללי") ────────────────────────────
// Backfills photos for existing candidates + kicks the semantic backfill.

export async function refreshAllHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    ok(res, await svc.refreshAllCandidateData());
  } catch (e) { next(e); }
}

// ── Reject (mark as not-a-profile) ───────────────────────

export async function rejectHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const messageId = String(req.params['messageId'] ?? '');
    ok(res, await svc.rejectExtraction(messageId));
  } catch (e) { next(e); }
}

// ── Ignore a source group (block future cards; optionally purge queue) ──

export async function ignoreGroupHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const body = req.body as {
      channelId?: string;
      chatJid?: string;
      chatName?: string;
      purgeQueued?: boolean;
    } | undefined;
    ok(res, await svc.ignoreSourceGroup(
      String(body?.channelId ?? ''),
      String(body?.chatJid ?? ''),
      user.id,
      {
        purgeQueued: body?.purgeQueued === true,
        chatName: typeof body?.chatName === 'string' ? body.chatName : undefined,
      },
    ));
  } catch (e) { next(e); }
}

// ── Card-label dictionary (operator-taught label→field mappings) ──

export async function listCardLabelsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    ok(res, await cardLabels.listCardLabels());
  } catch (e) { next(e); }
}

export async function createCardLabelHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const body = req.body as { label?: string; field?: string } | undefined;
    ok(res, await cardLabels.createCardLabel(String(body?.label ?? ''), String(body?.field ?? ''), user.id));
  } catch (e) { next(e); }
}

export async function deleteCardLabelHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    await cardLabels.deleteCardLabel(String(req.params['id'] ?? ''));
    ok(res, { deleted: true });
  } catch (e) { next(e); }
}

// Analyze a pasted card → recognized fields + unknown labels (with AI-suggested
// field per label) so a whole new format can be taught in one shot.
export async function analyzeCardHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const body = req.body as { text?: string } | undefined;
    ok(res, await cardLabels.analyzeCard(String(body?.text ?? ''), user.id));
  } catch (e) { next(e); }
}

export async function bulkCardLabelsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const body = req.body as { mappings?: Array<{ label?: unknown; field?: unknown }> } | undefined;
    const mappings = (body?.mappings ?? [])
      .map((m) => ({ label: String(m.label ?? ''), field: String(m.field ?? '') }))
      .filter((m) => m.label && m.field);
    ok(res, await cardLabels.createCardLabelsBulk(mappings, user.id));
  } catch (e) { next(e); }
}
