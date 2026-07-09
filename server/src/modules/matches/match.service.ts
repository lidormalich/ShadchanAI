// ═══════════════════════════════════════════════════════════
// ShadchanAI — Match Suggestion Service (barrel + create paths)
//
// The match service was split into cohesive files:
//   - match.query.ts      list / get / explanation payload (reads)
//   - match.scoring.ts    engine evaluation + find/blocked (no writes)
//   - match.lifecycle.ts  approve/decline/defer/.../applyInboundResponse
//   - match.send.ts       sendProposal (the single outbound path)
//
// This file keeps the create paths (createManualSuggestion /
// forceCreateSuggestion) — they engine-score AND persist — and
// re-exports the split modules so existing importers of
// './match.service.js' keep working unchanged.
//
// The engine is never bypassed. AI is never used for scoring.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import {
  AuditActionType,
  AuditEntityType,
  BlockerCode,
  MatchSuggestionStatus,
  SourceMode,
} from '@shadchanai/shared';
import {
  MatchSuggestion,
  type IMatchSuggestion,
} from '../../models/index.js';
import { audit } from '../../services/audit.service.js';
import { BusinessRuleError, ConflictError } from '../../utils/errors.js';
import type { MatchResult } from '../../services/matching/matching.types.js';
import { evaluatePair } from './match.scoring.js';
import { publishMatchUpdate } from './match.events.js';

// ── Re-exports (stable public surface) ───────────────────

export { listMatches, getMatchById, getExplanationPayload } from './match.query.js';
export { explainMatchSuggestion, type MatchExplanationDTO, type ExplainMatchResult } from './match.explain.js';
export {
  evaluatePair,
  previewSendReadiness,
  buildEngineContext,
  findMatchesForInternal,
  findBlockedForInternal,
  type FindMatchItem,
  type BlockedMatchItem,
} from './match.scoring.js';
export {
  approveSuggestion,
  declineSuggestion,
  deferSuggestion,
  reopenFromDeferred,
  markMatchDating,
  closeSuggestion,
  acknowledgeResponse,
  saveDraft,
  applyInboundResponse,
} from './match.lifecycle.js';
export {
  sendProposal,
  type SendProposalInput,
  type SendProposalResult,
} from './match.send.js';

// ── Create manual suggestion (engine-scored + persisted) ──

export async function createManualSuggestion(
  internalId: string,
  externalId: string,
  mode: SourceMode,
  performedBy: string,
): Promise<IMatchSuggestion> {
  // Engine must score first — never persist a fake score
  const result = await evaluatePair(internalId, externalId, mode);

  if (!result.eligible) {
    throw new BusinessRuleError(
      `Pair is not eligible: ${result.hardBlockers.join('; ')}`,
      { blockers: result.hardBlockers },
    );
  }

  // Duplicate guard (also enforced by partial unique index)
  const existing = await MatchSuggestion.findOne({
    internalCandidateId: new Types.ObjectId(internalId),
    externalCandidateId: new Types.ObjectId(externalId),
    status: { $nin: ['closed', 'expired'] },
  }).exec();
  if (existing) throw new ConflictError('An active suggestion already exists for this pair');

  const doc = await MatchSuggestion.create({
    internalCandidateId: new Types.ObjectId(internalId),
    externalCandidateId: new Types.ObjectId(externalId),
    eligible: true,
    status: MatchSuggestionStatus.DRAFT,
    matchScore: result.matchScore,
    confidenceScore: result.confidenceScore,
    matchType: result.matchType,
    riskLevel: result.riskLevel,
    scoreBreakdown: result.scoreBreakdown,
    hardBlockers: result.hardBlockers,
    blockers: result.blockers,
    strengths: result.strengths,
    attentionPoints: result.attentionPoints,
    overrideReasons: result.overrideReasons,
    flexibilityOverrideApplied: result.flexibilityOverrideApplied,
    forcedOverride: false,
    recommendedAction: result.recommendedAction,
    sendStrategy: result.sendStrategy,
    sourceMode: mode,
    penalties: result.penalties,
    semanticSimilarityScore: result.semanticSimilarityScore,
    ownerUserId: new Types.ObjectId(performedBy),
  });

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: String(doc._id),
    actionType: AuditActionType.CREATE,
    performedBy,
    after: doc.toObject(),
    metadata: { source: 'manual_suggestion', mode },
  });

  return doc;
}

// ── Force-create suggestion (override overridable blockers) ──
//
// Creates a suggestion for a pair the engine flagged ineligible.
// Safety: rejects if ANY blocker is overridable=NONE. The operator
// must supply a justification; the created row is tagged
// forcedOverride=true with blockers retained for audit.
export async function forceCreateSuggestion(
  internalId: string,
  externalId: string,
  mode: SourceMode,
  justification: string,
  performedBy: string,
): Promise<IMatchSuggestion> {
  const result = await evaluatePair(internalId, externalId, mode);

  // If the pair is already eligible, fall back to a regular manual
  // create — no "force" needed.
  if (result.eligible) {
    return createManualSuggestion(internalId, externalId, mode, performedBy);
  }

  const nonOverridable = result.blockers.filter((b) => b.overridable === 'none');
  if (nonOverridable.length > 0) {
    throw new BusinessRuleError(
      'Pair contains non-overridable blockers: ' + nonOverridable.map((b) => b.message).join('; '),
      { code: 'non_overridable_blocker', blockers: nonOverridable },
    );
  }

  // A partial unique index forbids two active suggestions per pair, so
  // when one already exists we REFRESH + force it in place rather than
  // inserting a duplicate. This is the duplicate-blocker case (the
  // ACTIVE_PAIR_DUPLICATE blocker is self-referential here — it points
  // at the very row we're about to refresh — so it's not re-recorded).
  const existing = await MatchSuggestion.findOne({
    internalCandidateId: new Types.ObjectId(internalId),
    externalCandidateId: new Types.ObjectId(externalId),
    status: { $nin: ['closed', 'expired'] },
  }).exec();
  if (existing) {
    return refreshForceExisting(existing, result, justification, performedBy);
  }

  const overrideReasons = [
    `נכפה ידנית: ${justification}`,
    ...result.blockers.map((b) => `חסם: ${b.message}`),
  ];

  const doc = await MatchSuggestion.create({
    internalCandidateId: new Types.ObjectId(internalId),
    externalCandidateId: new Types.ObjectId(externalId),
    // Persist as eligible so downstream lifecycle (approve/send) works;
    // the forcedOverride flag + retained blockers preserve the truth.
    eligible: true,
    status: MatchSuggestionStatus.DRAFT,
    matchScore: result.matchScore,
    confidenceScore: result.confidenceScore,
    matchType: result.matchType,
    riskLevel: result.riskLevel,
    scoreBreakdown: result.scoreBreakdown,
    hardBlockers: result.hardBlockers,
    blockers: result.blockers,
    strengths: result.strengths,
    attentionPoints: result.attentionPoints,
    overrideReasons,
    flexibilityOverrideApplied: true,
    forcedOverride: true,
    recommendedAction: result.recommendedAction,
    sendStrategy: result.sendStrategy,
    sourceMode: mode,
    penalties: result.penalties,
    semanticSimilarityScore: result.semanticSimilarityScore,
    ownerUserId: new Types.ObjectId(performedBy),
  });

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: String(doc._id),
    actionType: AuditActionType.MATCH_FORCED,
    performedBy,
    after: doc.toObject(),
    metadata: {
      source: 'force_suggestion',
      mode,
      justification,
      blockers: result.blockers,
    },
  });

  publishMatchUpdate(doc, 'forced');
  return doc;
}

// Refresh + force an already-active suggestion in place. Used when the
// operator forces a pair that already has an active suggestion: the DB
// forbids a second active row, so we annotate the existing one as forced
// (justification + any OTHER overridable blockers) without disturbing
// its engine scores or lifecycle position.
async function refreshForceExisting(
  existing: IMatchSuggestion,
  result: MatchResult,
  justification: string,
  performedBy: string,
): Promise<IMatchSuggestion> {
  const before = existing.toObject();

  // The duplicate blocker points at `existing` itself — drop it so we
  // don't record a pair as "blocked by its own suggestion".
  const otherBlockers = result.blockers.filter(
    (b) => b.code !== BlockerCode.ACTIVE_PAIR_DUPLICATE,
  );
  const newReasons = [
    `נכפה ידנית (רענון הצעה קיימת): ${justification}`,
    ...otherBlockers.map((b) => `חסם: ${b.message}`),
  ];

  existing.forcedOverride = true;
  existing.flexibilityOverrideApplied = true;
  existing.overrideReasons = Array.from(
    new Set([...(existing.overrideReasons ?? []), ...newReasons]),
  );
  if (otherBlockers.length > 0) {
    existing.blockers = otherBlockers;
    existing.markModified('blockers');
  }
  await existing.save();

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: String(existing._id),
    actionType: AuditActionType.MATCH_FORCED,
    performedBy,
    before,
    after: existing.toObject(),
    metadata: {
      source: 'force_refresh_existing',
      justification,
      blockers: otherBlockers,
    },
  });

  publishMatchUpdate(existing, 'forced');
  return existing;
}
