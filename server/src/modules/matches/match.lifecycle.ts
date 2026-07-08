// ═══════════════════════════════════════════════════════════
// ShadchanAI — Match lifecycle state machine
//
// Every transition here enforces the allowed source states,
// persists the change, audits it, and publishes a realtime event.
// applyInboundResponse is the auto-detection entry used by the
// WhatsApp handler; it lives here because it advances the same
// state machine.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import {
  AuditActionType,
  AuditEntityType,
  MatchSuggestionStatus,
} from '@shadchanai/shared';
import {
  MatchSuggestion,
  type IMatchSuggestion,
} from '../../models/index.js';
import { audit } from '../../services/audit.service.js';
import { BusinessRuleError } from '../../utils/errors.js';
import { assertOwnership } from '../../utils/ownership.assert.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';
import { getMatchById } from './match.query.js';
import { publishMatchUpdate } from './match.events.js';

// ── Lifecycle transitions ────────────────────────────────

/**
 * Append the transition (+ the operator's WHY) to the suggestion's
 * status journal. Every transition records here — the per-candidate
 * learning agent reads this corpus to understand what each candidate
 * responds to and refine future match direction.
 */
function recordStatusChange(
  doc: IMatchSuggestion,
  status: MatchSuggestionStatus,
  reason: string | undefined,
  performedBy?: string,
  auto = false,
): void {
  doc.statusHistory = [
    ...(doc.statusHistory ?? []),
    {
      status,
      reason: reason?.trim() || undefined,
      at: new Date(),
      by: performedBy ? new Types.ObjectId(performedBy) : undefined,
      auto: auto || undefined,
    },
  ];
}

export async function approveSuggestion(
  id: string,
  performedBy: string,
  actor?: AuthUser,
  reason?: string,
): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'match suggestion' });
  if (doc.status !== MatchSuggestionStatus.DRAFT && doc.status !== MatchSuggestionStatus.PENDING_APPROVAL) {
    throw new BusinessRuleError(`Cannot approve from status: ${doc.status}`);
  }
  const before = doc.toObject();
  doc.status = MatchSuggestionStatus.APPROVED;
  doc.approvedBy = new Types.ObjectId(performedBy);
  doc.approvedAt = new Date();
  recordStatusChange(doc, MatchSuggestionStatus.APPROVED, reason, performedBy);
  await doc.save();

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: id,
    actionType: AuditActionType.MATCH_APPROVED,
    performedBy,
    before,
    after: doc.toObject(),
  });

  publishMatchUpdate(doc, 'approved');
  return doc;
}

export async function declineSuggestion(
  id: string,
  side: 'a' | 'b',
  reason: string | undefined,
  notes: string | undefined,
  performedBy: string,
  actor?: AuthUser,
): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'match suggestion' });
  const before = doc.toObject();

  const sideResponse = { status: 'declined', respondedAt: new Date(), declineReason: reason, notes };
  if (side === 'a') {
    doc.sideAResponse = sideResponse as IMatchSuggestion['sideAResponse'];
    doc.status = MatchSuggestionStatus.DECLINED_SIDE_A;
  } else {
    doc.sideBResponse = sideResponse as IMatchSuggestion['sideBResponse'];
    doc.status = MatchSuggestionStatus.DECLINED_SIDE_B;
  }
  recordStatusChange(doc, doc.status, [reason, notes].filter(Boolean).join(' — ') || undefined, performedBy);
  await doc.save();

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: id,
    actionType: AuditActionType.MATCH_DECLINED,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { side, reason },
  });

  publishMatchUpdate(doc, 'declined');
  return doc;
}

export async function deferSuggestion(
  id: string,
  reason: string,
  performedBy: string,
  actor?: AuthUser,
): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'match suggestion' });
  if (doc.status === MatchSuggestionStatus.CLOSED || doc.status === MatchSuggestionStatus.EXPIRED) {
    throw new BusinessRuleError('Cannot defer a closed/expired suggestion');
  }
  const before = doc.toObject();
  doc.isDeferred = true;
  doc.deferredAt = new Date();
  doc.deferredReason = reason;
  doc.status = MatchSuggestionStatus.DEFERRED;
  recordStatusChange(doc, MatchSuggestionStatus.DEFERRED, reason, performedBy);
  await doc.save();

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: id,
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { transition: 'defer', reason },
  });

  publishMatchUpdate(doc, 'deferred');
  return doc;
}

export async function reopenFromDeferred(id: string, performedBy: string, actor?: AuthUser): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'match suggestion' });
  if (!doc.isDeferred) throw new BusinessRuleError('Suggestion is not deferred');

  const before = doc.toObject();
  doc.isDeferred = false;
  doc.reopenedFromDeferredAt = new Date();
  doc.status = doc.approvedBy ? MatchSuggestionStatus.APPROVED : MatchSuggestionStatus.DRAFT;
  recordStatusChange(doc, doc.status, 'נפתח מחדש מהשהיה', performedBy);
  await doc.save();

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: id,
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { transition: 'reopen_from_deferred' },
  });

  return doc;
}

export async function markMatchDating(
  id: string,
  performedBy: string,
  actor?: AuthUser,
  reason?: string,
): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'match suggestion' });
  const before = doc.toObject();
  doc.status = MatchSuggestionStatus.DATING;
  doc.datingStartedAt = new Date();
  recordStatusChange(doc, MatchSuggestionStatus.DATING, reason, performedBy);
  await doc.save();

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: id,
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { transition: 'mark_dating' },
  });

  return doc;
}

export async function closeSuggestion(
  id: string,
  reason: string,
  performedBy: string,
  actor?: AuthUser,
  opts?: { closureReason?: string; sideAReason?: string; sideBReason?: string },
): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'match suggestion' });
  const before = doc.toObject();
  doc.status = MatchSuggestionStatus.CLOSED;
  doc.closedAt = new Date();
  doc.closeReason = reason;

  // Per-side "why it didn't fit" — persisted on each side's response so
  // the candidate-learning agent (which reads sideXResponse.declineReason)
  // learns what THIS candidate specifically didn't want. Only touched when
  // a reason is actually provided, so a happy close never fabricates one.
  const sideAReason = opts?.sideAReason?.trim();
  const sideBReason = opts?.sideBReason?.trim();
  if (sideAReason) {
    doc.sideAResponse = { ...(doc.sideAResponse ?? { status: 'pending' }), declineReason: sideAReason } as IMatchSuggestion['sideAResponse'];
    doc.markModified('sideAResponse');
  }
  if (sideBReason) {
    doc.sideBResponse = { ...(doc.sideBResponse ?? { status: 'pending' }), declineReason: sideBReason } as IMatchSuggestion['sideBResponse'];
    doc.markModified('sideBResponse');
  }

  // Fold the structured outcome + per-side notes into the journal reason so
  // the learning corpus gets the full picture in one entry.
  const journalReason = [
    reason,
    sideAReason ? `צד א: ${sideAReason}` : undefined,
    sideBReason ? `צד ב: ${sideBReason}` : undefined,
  ].filter(Boolean).join(' — ');
  recordStatusChange(doc, MatchSuggestionStatus.CLOSED, journalReason, performedBy);
  await doc.save();

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: id,
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { transition: 'close', reason, closureReason: opts?.closureReason, sideAReason, sideBReason },
  });

  publishMatchUpdate(doc, 'closed');
  return doc;
}

// ── Acknowledge a side's response ────────────────────────
//
// Sets sideX.acknowledgedAt so the dashboard "new_response" row
// for that side stops appearing. Idempotent: calling it twice
// after the same respondedAt is a no-op.
export async function acknowledgeResponse(
  id: string,
  side: 'a' | 'b',
  performedBy: string,
): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  const response = side === 'a' ? doc.sideAResponse : doc.sideBResponse;
  if (!response?.respondedAt) return doc; // nothing to acknowledge
  if (response.acknowledgedAt && response.acknowledgedAt >= response.respondedAt) return doc;

  if (side === 'a') {
    doc.sideAResponse.acknowledgedAt = new Date();
    doc.sideAResponse.acknowledgedBy = new Types.ObjectId(performedBy);
  } else {
    doc.sideBResponse.acknowledgedAt = new Date();
    doc.sideBResponse.acknowledgedBy = new Types.ObjectId(performedBy);
  }
  doc.markModified(side === 'a' ? 'sideAResponse' : 'sideBResponse');
  await doc.save();
  publishMatchUpdate(doc, 'response_acknowledged', { side });
  return doc;
}

// ── Proposal drafts (persisted scratch space) ────────────

export async function saveDraft(
  id: string,
  side: 'a' | 'b',
  body: string,
  performedBy: string,
  source: 'ai' | 'manual' = 'manual',
  actor?: AuthUser,
): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  if (actor) assertOwnership(doc.ownerUserId, actor, { entity: 'match suggestion' });
  const entry = {
    body,
    updatedAt: new Date(),
    updatedBy: new Types.ObjectId(performedBy),
    source,
  };
  doc.drafts = doc.drafts ?? {};
  if (side === 'a') doc.drafts.sideA = entry;
  else doc.drafts.sideB = entry;
  // Mongoose needs a hint that a nested mixed subdoc changed
  doc.markModified('drafts');
  await doc.save();
  return doc;
}

// ── Apply inbound response (auto-detection on match_sending) ──
//
// Called by the WhatsApp message handler when an inbound message
// arrives on a conversation linked to a match. Updates the relevant
// sideXResponse and transitions the match state, preserving the
// acknowledgedAt field so the operator still has to actively see
// the response on the dashboard.
export async function applyInboundResponse(
  matchId: string,
  side: 'a' | 'b',
  status: 'accepted' | 'declined' | 'considering',
  metadata: {
    messageId: string;
    classifier: 'regex' | 'ai' | 'manual';
    classifierConfidence: number;
    rawText?: string;
  },
): Promise<IMatchSuggestion> {
  const doc = await getMatchById(matchId);
  const before = doc.toObject();
  const now = new Date();

  if (side === 'a') {
    doc.sideAResponse = {
      ...(doc.sideAResponse ?? { status: 'pending' }),
      status,
      respondedAt: now,
    } as IMatchSuggestion['sideAResponse'];
  } else {
    doc.sideBResponse = {
      ...(doc.sideBResponse ?? { status: 'pending' }),
      status,
      respondedAt: now,
    } as IMatchSuggestion['sideBResponse'];
  }
  doc.markModified(side === 'a' ? 'sideAResponse' : 'sideBResponse');

  // Status-machine advance. Only applied when decisive.
  const aStatus = side === 'a' ? status : doc.sideAResponse?.status;
  const bStatus = side === 'b' ? status : doc.sideBResponse?.status;
  if (status === 'declined') {
    doc.status = side === 'a'
      ? MatchSuggestionStatus.DECLINED_SIDE_A
      : MatchSuggestionStatus.DECLINED_SIDE_B;
  } else if (status === 'accepted') {
    if (aStatus === 'accepted' && bStatus === 'accepted') {
      doc.status = MatchSuggestionStatus.ACCEPTED_BOTH;
    } else {
      doc.status = side === 'a'
        ? MatchSuggestionStatus.ACCEPTED_SIDE_A
        : MatchSuggestionStatus.ACCEPTED_SIDE_B;
    }
  }
  // 'considering' leaves the match state machine untouched.

  if (status !== 'considering') {
    recordStatusChange(
      doc,
      doc.status,
      metadata.rawText ? `תגובה נכנסת (${side === 'a' ? 'צד א' : 'צד ב'}): ${metadata.rawText.slice(0, 200)}` : undefined,
      undefined,
      true,
    );
  }

  await doc.save();

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: matchId,
    actionType: AuditActionType.RESPONSE_DETECTED,
    // Auto-detection has no user context; use the match's owner
    // so the audit row still has a valid ObjectId (required field).
    performedBy: String(doc.ownerUserId),
    before,
    after: doc.toObject(),
    metadata: {
      side,
      status,
      classifier: metadata.classifier,
      classifierConfidence: metadata.classifierConfidence,
      messageId: metadata.messageId,
      ...(metadata.rawText ? { rawTextPreview: metadata.rawText.slice(0, 200) } : {}),
    },
  });

  publishMatchUpdate(doc, 'response_detected', {
    side,
    status,
    classifier: metadata.classifier,
  });
  return doc;
}
