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

// ── Reject (mark as not-a-profile) ───────────────────────

export async function rejectHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    canManageChannels(user);
    const messageId = String(req.params['messageId'] ?? '');
    ok(res, await svc.rejectExtraction(messageId));
  } catch (e) { next(e); }
}
