// ═══════════════════════════════════════════════════════════
// ShadchanAI — Match Suggestion Service
//
// All match-suggestion mutations go through here. The deterministic
// engine is the SOLE source of truth for scoring; this service:
//   - runs the engine on pair evaluation
//   - persists engine outputs onto a MatchSuggestion doc
//   - enforces the lifecycle state machine
//   - audits every transition
//
// The engine is never bypassed. AI is never used for scoring.
// AI is only used (advisory) for explanation text via ai.service.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import {
  AuditActionType,
  AuditEntityType,
  MatchSuggestionStatus,
  SourceMode,
} from '@shadchanai/shared';
import {
  MatchSuggestion,
  InternalCandidate,
  ExternalCandidate,
  type IMatchSuggestion,
} from '../../models/index.js';
import { audit } from '../../services/audit.service.js';
import { BusinessRuleError, NotFoundError, ConflictError } from '../../utils/errors.js';
import { toSkipLimit, buildSort, makeMeta } from '../../utils/pagination.js';
import { evaluatePair as engineEvaluatePair } from '../../services/matching/matching.engine.js';
import { computeReadiness } from '../candidates/internal-candidate.service.js';
import type {
  MatchableInternal,
  MatchableExternal,
  MatchingContext,
  MatchResult,
} from '../../services/matching/matching.types.js';
import type { ListMatchesQuery } from './match.validator.js';

// ── List / pipeline ──────────────────────────────────────

export async function listMatches(
  query: ListMatchesQuery,
): Promise<{ items: IMatchSuggestion[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  const { skip, limit } = toSkipLimit(query);
  const sort = buildSort(query, 'matchScore');

  const filter: Record<string, unknown> = {};
  if (query.status) filter['status'] = query.status;
  if (query.matchType) filter['matchType'] = query.matchType;
  if (query.internalCandidateId) filter['internalCandidateId'] = new Types.ObjectId(query.internalCandidateId);
  if (query.externalCandidateId) filter['externalCandidateId'] = new Types.ObjectId(query.externalCandidateId);
  if (query.isDeferred !== undefined) filter['isDeferred'] = query.isDeferred;
  if (query.minScore !== undefined) filter['matchScore'] = { $gte: query.minScore };

  const [items, total] = await Promise.all([
    MatchSuggestion.find(filter).sort(sort).skip(skip).limit(limit).lean().exec(),
    MatchSuggestion.countDocuments(filter).exec(),
  ]);

  return {
    items: items as unknown as IMatchSuggestion[],
    total,
    meta: makeMeta(query.page, query.limit, total),
  };
}

export async function getMatchById(id: string): Promise<IMatchSuggestion> {
  const doc = await MatchSuggestion.findById(id).exec();
  if (!doc) throw new NotFoundError('MatchSuggestion', id);
  return doc;
}

// ── Evaluate pair (engine only, no persistence) ──────────

export async function evaluatePair(
  internalId: string,
  externalId: string,
  mode: SourceMode,
): Promise<MatchResult> {
  const [internal, external] = await Promise.all([
    InternalCandidate.findById(internalId).lean().exec(),
    ExternalCandidate.findById(externalId).lean().exec(),
  ]);
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);
  if (!external) throw new NotFoundError('ExternalCandidate', externalId);

  const ctx = await buildEngineContext(internalId, mode);
  return engineEvaluatePair(
    toMatchableInternal(internal),
    toMatchableExternal(external),
    ctx,
  );
}

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
    strengths: result.strengths,
    attentionPoints: result.attentionPoints,
    overrideReasons: result.overrideReasons,
    flexibilityOverrideApplied: result.flexibilityOverrideApplied,
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

// ── Lifecycle transitions ────────────────────────────────

export async function approveSuggestion(id: string, performedBy: string): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  if (doc.status !== MatchSuggestionStatus.DRAFT && doc.status !== MatchSuggestionStatus.PENDING_APPROVAL) {
    throw new BusinessRuleError(`Cannot approve from status: ${doc.status}`);
  }
  const before = doc.toObject();
  doc.status = MatchSuggestionStatus.APPROVED;
  doc.approvedBy = new Types.ObjectId(performedBy);
  doc.approvedAt = new Date();
  await doc.save();

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: id,
    actionType: AuditActionType.MATCH_APPROVED,
    performedBy,
    before,
    after: doc.toObject(),
  });

  return doc;
}

export async function declineSuggestion(
  id: string,
  side: 'a' | 'b',
  reason: string | undefined,
  notes: string | undefined,
  performedBy: string,
): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  const before = doc.toObject();

  const sideResponse = { status: 'declined', respondedAt: new Date(), declineReason: reason, notes };
  if (side === 'a') {
    doc.sideAResponse = sideResponse as IMatchSuggestion['sideAResponse'];
    doc.status = MatchSuggestionStatus.DECLINED_SIDE_A;
  } else {
    doc.sideBResponse = sideResponse as IMatchSuggestion['sideBResponse'];
    doc.status = MatchSuggestionStatus.DECLINED_SIDE_B;
  }
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

  return doc;
}

export async function deferSuggestion(
  id: string,
  reason: string,
  performedBy: string,
): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  if (doc.status === MatchSuggestionStatus.CLOSED || doc.status === MatchSuggestionStatus.EXPIRED) {
    throw new BusinessRuleError('Cannot defer a closed/expired suggestion');
  }
  const before = doc.toObject();
  doc.isDeferred = true;
  doc.deferredAt = new Date();
  doc.deferredReason = reason;
  doc.status = MatchSuggestionStatus.DEFERRED;
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

  return doc;
}

export async function reopenFromDeferred(id: string, performedBy: string): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  if (!doc.isDeferred) throw new BusinessRuleError('Suggestion is not deferred');

  const before = doc.toObject();
  doc.isDeferred = false;
  doc.reopenedFromDeferredAt = new Date();
  doc.status = doc.approvedBy ? MatchSuggestionStatus.APPROVED : MatchSuggestionStatus.DRAFT;
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

export async function markMatchDating(id: string, performedBy: string): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  const before = doc.toObject();
  doc.status = MatchSuggestionStatus.DATING;
  doc.datingStartedAt = new Date();
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
): Promise<IMatchSuggestion> {
  const doc = await getMatchById(id);
  const before = doc.toObject();
  doc.status = MatchSuggestionStatus.CLOSED;
  doc.closedAt = new Date();
  doc.closeReason = reason;
  await doc.save();

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: id,
    actionType: AuditActionType.STATUS_CHANGE,
    performedBy,
    before,
    after: doc.toObject(),
    metadata: { transition: 'close', reason },
  });

  return doc;
}

// ── Explanation payload (engine data for AI/UI display) ──

export async function getExplanationPayload(id: string): Promise<{
  matchScore: number;
  confidenceScore: number;
  matchType: string;
  riskLevel: string;
  scoreBreakdown: unknown[];
  strengths: string[];
  attentionPoints: string[];
  overrideReasons: string[];
  recommendedAction: string;
  aiExplanation?: unknown;
}> {
  const doc = await getMatchById(id);
  return {
    matchScore: doc.matchScore,
    confidenceScore: doc.confidenceScore,
    matchType: doc.matchType,
    riskLevel: doc.riskLevel,
    scoreBreakdown: doc.scoreBreakdown,
    strengths: doc.strengths,
    attentionPoints: doc.attentionPoints,
    overrideReasons: doc.overrideReasons,
    recommendedAction: doc.recommendedAction,
    aiExplanation: doc.aiExplanation,
  };
}

// ── Preview send readiness ───────────────────────────────

export async function previewSendReadiness(id: string): Promise<{
  matchId: string;
  canSend: boolean;
  blockers: string[];
  internalCandidateReadiness: ReturnType<typeof computeReadiness>;
  externalCandidateAvailable: boolean;
  engineRecommendedAction: string;
}> {
  const match = await getMatchById(id);
  const [internal, external] = await Promise.all([
    InternalCandidate.findById(match.internalCandidateId).lean().exec(),
    ExternalCandidate.findById(match.externalCandidateId).lean().exec(),
  ]);
  if (!internal) throw new NotFoundError('InternalCandidate', String(match.internalCandidateId));
  if (!external) throw new NotFoundError('ExternalCandidate', String(match.externalCandidateId));

  const readiness = computeReadiness(internal as unknown as Parameters<typeof computeReadiness>[0]);
  const blockers = [...readiness.sendReadinessBlockers];

  const externalAvailable = external.status === 'active'
    && external.availabilityStatus !== 'unavailable'
    && external.availabilityStatus !== 'dating';
  if (!externalAvailable) blockers.push(`External candidate not available (${external.availabilityStatus})`);

  if (external.shareCard && !external.shareCard.approvedForShare) {
    blockers.push('External share card not approved');
  }

  if (match.status === 'closed' || match.status === 'expired') {
    blockers.push(`Match in terminal status: ${match.status}`);
  }

  if (match.isDeferred) {
    blockers.push('Match is currently deferred');
  }

  const canSend = blockers.length === 0;

  return {
    matchId: id,
    canSend,
    blockers,
    internalCandidateReadiness: readiness,
    externalCandidateAvailable: externalAvailable,
    engineRecommendedAction: match.recommendedAction,
  };
}

// ── Context builder for engine ───────────────────────────

async function buildEngineContext(internalId: string, mode: SourceMode): Promise<MatchingContext> {
  const active = await MatchSuggestion.find({
    internalCandidateId: new Types.ObjectId(internalId),
    status: { $nin: ['closed', 'expired'] },
  }).select('externalCandidateId').lean().exec();

  const declines = await MatchSuggestion.find({
    internalCandidateId: new Types.ObjectId(internalId),
    status: { $in: ['declined_side_a', 'declined_side_b'] },
  }).select('externalCandidateId closedAt').lean().exec();

  const activeMatchExternalIds = new Set<string>(active.map((s) => String(s.externalCandidateId)));
  const recentDeclines = new Map<string, Date>();
  for (const d of declines) {
    if (d.closedAt) recentDeclines.set(String(d.externalCandidateId), d.closedAt);
  }

  return {
    mode,
    activeMatchExternalIds,
    recentDeclines,
    activeSuggestionCount: active.length,
  };
}

// ── Conversions ───────────────────────────────────────────

function toMatchableInternal(doc: Record<string, unknown>): MatchableInternal {
  return {
    _id: String(doc['_id']),
    firstName: (doc['firstName'] as string) ?? '',
    lastName: (doc['lastName'] as string) ?? '',
    gender: doc['gender'] as MatchableInternal['gender'],
    dateOfBirth: doc['dateOfBirth'] as Date,
    city: doc['city'] as string | undefined,
    height: doc['height'] as number | undefined,
    sectorGroup: doc['sectorGroup'] as MatchableInternal['sectorGroup'],
    subSector: doc['subSector'] as MatchableInternal['subSector'],
    lifestyleTone: doc['lifestyleTone'] as MatchableInternal['lifestyleTone'],
    religiousStyle: doc['religiousStyle'] as MatchableInternal['religiousStyle'],
    personalStatus: (doc['personalStatus'] as MatchableInternal['personalStatus']) ?? 'single',
    numberOfChildren: (doc['numberOfChildren'] as number) ?? 0,
    lifeStage: doc['lifeStage'] as MatchableInternal['lifeStage'],
    readinessForMarriage: (doc['readinessForMarriage'] as MatchableInternal['readinessForMarriage']) ?? 'open',
    studyWorkDirection: doc['studyWorkDirection'] as MatchableInternal['studyWorkDirection'],
    hardConstraints: (doc['hardConstraints'] as MatchableInternal['hardConstraints']) ?? [],
    softPreferences: (doc['softPreferences'] as MatchableInternal['softPreferences']) ?? [],
    agePreferences: doc['agePreferences'] as MatchableInternal['agePreferences'],
    locationPreferences: doc['locationPreferences'] as MatchableInternal['locationPreferences'],
    openness: (doc['openness'] as MatchableInternal['openness']) ?? {
      openToOtherSectors: false, openToConverts: false, openToDivorced: false,
      openToWithChildren: false, openToAgeDifference: false, openToLongDistance: false,
    },
    profileCompletion: (doc['profileCompletion'] as number) ?? 0,
    missingCriticalFields: (doc['missingCriticalFields'] as string[]) ?? [],
    sendReadinessBlockers: (doc['sendReadinessBlockers'] as string[]) ?? [],
    profileQualityScore: doc['profileQualityScore'] as number | undefined,
    dataReliabilityScore: doc['dataReliabilityScore'] as number | undefined,
    readinessScore: doc['readinessScore'] as number | undefined,
    status: (doc['status'] as MatchableInternal['status']) ?? 'active',
    lastVerifiedAt: doc['lastVerifiedAt'] as Date | undefined,
    lastActionAt: doc['lastActionAt'] as Date | undefined,
    datingPartnerCandidateId: doc['datingPartnerCandidateId']
      ? String(doc['datingPartnerCandidateId']) : undefined,
    deferredSuggestionsCount: (doc['deferredSuggestionsCount'] as number) ?? 0,
  };
}

function toMatchableExternal(doc: Record<string, unknown>): MatchableExternal {
  return {
    _id: String(doc['_id']),
    firstName: doc['firstName'] as string | undefined,
    lastName: doc['lastName'] as string | undefined,
    gender: doc['gender'] as MatchableExternal['gender'],
    age: doc['age'] as number | undefined,
    city: doc['city'] as string | undefined,
    height: doc['height'] as number | undefined,
    sectorGroup: doc['sectorGroup'] as MatchableExternal['sectorGroup'],
    subSector: doc['subSector'] as MatchableExternal['subSector'],
    lifestyleTone: doc['lifestyleTone'] as MatchableExternal['lifestyleTone'],
    personalStatus: doc['personalStatus'] as MatchableExternal['personalStatus'],
    lifeStage: doc['lifeStage'] as MatchableExternal['lifeStage'],
    studyWorkDirection: doc['studyWorkDirection'] as MatchableExternal['studyWorkDirection'],
    availabilityStatus: (doc['availabilityStatus'] as MatchableExternal['availabilityStatus']) ?? 'unknown',
    status: (doc['status'] as MatchableExternal['status']) ?? 'active',
    shareCard: (doc['shareCard'] as MatchableExternal['shareCard']) ?? { approvedForShare: false },
    ageReliability: doc['ageReliability'] as MatchableExternal['ageReliability'],
    // Bidirectional preferences (optional on external)
    hardConstraints: doc['hardConstraints'] as MatchableExternal['hardConstraints'],
    softPreferences: doc['softPreferences'] as MatchableExternal['softPreferences'],
    agePreferences: doc['agePreferences'] as MatchableExternal['agePreferences'],
    locationPreferences: doc['locationPreferences'] as MatchableExternal['locationPreferences'],
    openness: doc['openness'] as MatchableExternal['openness'],
    staleAt: doc['staleAt'] as Date | undefined,
    lastConfirmedAvailableAt: doc['lastConfirmedAvailableAt'] as Date | undefined,
    lastSourceUpdateAt: doc['lastSourceUpdateAt'] as Date | undefined,
    sourceImportedAt: (doc['sourceImportedAt'] as Date) ?? new Date(0),
  };
}

// ── Find matches for an internal candidate (bulk evaluate) ──
//
// Runs the deterministic engine against every currently-available
// external candidate of the opposite gender. No persistence — returns
// the top-N eligible results sorted by matchScore. Use to surface
// candidate matches in the UI; the operator then picks one to turn
// into a persisted MatchSuggestion via createManualSuggestion.

export interface FindMatchItem {
  externalCandidateId: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  city?: string | undefined;
  age?: number | undefined;
  sectorGroup?: string | undefined;
  matchScore: number;
  confidenceScore: number;
  matchType: MatchResult['matchType'];
  riskLevel: MatchResult['riskLevel'];
  strengths: string[];
  attentionPoints: string[];
  recommendedAction: MatchResult['recommendedAction'];
}

export async function findMatchesForInternal(
  internalId: string,
  mode: SourceMode,
  limit = 20,
): Promise<FindMatchItem[]> {
  const internal = await InternalCandidate.findById(internalId).lean().exec();
  if (!internal) throw new NotFoundError('InternalCandidate', internalId);

  const oppositeGender = (internal as { gender?: string }).gender === 'male' ? 'female' : 'male';

  const externals = await ExternalCandidate.find({
    gender: oppositeGender,
    status: 'active',
    availabilityStatus: { $in: ['available', 'unknown'] },
  }).lean().exec();

  const ctx = await buildEngineContext(internalId, mode);
  const matchable = toMatchableInternal(internal);

  const results: FindMatchItem[] = [];
  for (const ext of externals) {
    const r = engineEvaluatePair(matchable, toMatchableExternal(ext), ctx);
    if (!r.eligible) continue;
    results.push({
      externalCandidateId: String(ext._id),
      firstName: ext['firstName'] as string | undefined,
      lastName: ext['lastName'] as string | undefined,
      city: ext['city'] as string | undefined,
      age: ext['age'] as number | undefined,
      sectorGroup: ext['sectorGroup'] as string | undefined,
      matchScore: r.matchScore,
      confidenceScore: r.confidenceScore,
      matchType: r.matchType,
      riskLevel: r.riskLevel,
      strengths: r.strengths,
      attentionPoints: r.attentionPoints,
      recommendedAction: r.recommendedAction,
    });
  }

  results.sort((a, b) => b.matchScore - a.matchScore);
  return results.slice(0, limit);
}

// ═══════════════════════════════════════════════════════════
// Outbound proposal sending (human-approved)
//
// SINGLE authoritative send path for a match proposal.
// Gates, in order — each exists to protect a specific invariant:
//
//   1. Re-run send-preview INSIDE the service (not trusted from client)
//   2. Not-already-sent on this side
//   3. Channel exists + role === match_sending
//   4. Resolve destination conversation + participantPhone → JID
//   5. PRE-FLIGHT audit (stage=attempt) BEFORE the socket is touched
//   6. Socket send via provider-safe sendTextFromChannel
//   7. On failure: persist FAILED Message row + audit stage=failed, throw
//   8. On success: persist SENT Message row, advance match state machine,
//      audit MATCH_SENT + MESSAGE_SENT stage=success
//
// AI has NO path into this function — it requires a performedBy
// that only the authenticated HTTP controller supplies.
// ═══════════════════════════════════════════════════════════

import { Message as MessageModel, Conversation as ConversationModel, Channel as ChannelModel } from '../../models/index.js';
import { phoneToJid, sendTextFromChannel } from '../../services/whatsapp/whatsapp.service.js';
import { checkAndConsumeSendQuota } from '../../services/whatsapp/send.rate-limiter.js';
import { ChannelRole as ChannelRoleEnum, MessageDirection, MessageDeliveryStatus } from '@shadchanai/shared';

export interface SendProposalInput {
  side: 'a' | 'b';
  channelId: string;
  body: string;
  performedBy: string;
}

export interface SendProposalResult {
  messageId: string;
  externalMessageId: string;
  conversationId: string;
  matchStatus: string;
}

export async function sendProposal(
  matchId: string,
  input: SendProposalInput,
): Promise<SendProposalResult> {
  const preview = await previewSendReadiness(matchId);
  if (!preview.canSend) {
    throw new BusinessRuleError(
      'Match is not ready to send: ' + preview.blockers.join('; '),
      { code: 'not_ready_to_send', blockers: preview.blockers },
    );
  }

  const match = await getMatchById(matchId);

  if (input.side === 'a' && match.sentSideAAt) {
    throw new BusinessRuleError('Side A has already received this proposal', { code: 'already_sent_side_a' });
  }
  if (input.side === 'b' && match.sentSideBAt) {
    throw new BusinessRuleError('Side B has already received this proposal', { code: 'already_sent_side_b' });
  }

  const channel = await ChannelModel.findOne({ channelId: input.channelId }).exec();
  if (!channel) {
    throw new BusinessRuleError('Channel not found', { code: 'channel_not_found' });
  }
  if (channel.role !== ChannelRoleEnum.MATCH_SENDING) {
    throw new BusinessRuleError(
      'Outbound proposals may only be sent from a match_sending channel',
      { code: 'wrong_channel_role', role: channel.role },
    );
  }

  // Resolve the side's conversation on THIS channel
  const conversationFilter: Record<string, unknown> = {
    channelId: channel.channelId,
    archivedAt: { $exists: false },
  };
  if (input.side === 'a') {
    conversationFilter['internalCandidateId'] = match.internalCandidateId;
  } else {
    conversationFilter['externalCandidateId'] = match.externalCandidateId;
  }
  const conversation = await ConversationModel.findOne(conversationFilter)
    .sort({ lastMessageAt: -1 })
    .exec();
  if (!conversation || !conversation.participantPhone) {
    throw new BusinessRuleError(
      'No reachable conversation on channel ' + channel.channelId + ' for side ' + input.side.toUpperCase(),
      { code: 'no_conversation_for_side' },
    );
  }

  const jid = phoneToJid(conversation.participantPhone);

  checkAndConsumeSendQuota({ channelId: channel.channelId, userId: input.performedBy });

  // Pre-flight audit BEFORE the socket is touched
  await audit({
    entityType: AuditEntityType.MESSAGE,
    entityId: String(conversation._id),
    actionType: AuditActionType.MESSAGE_SENT,
    performedBy: input.performedBy,
    metadata: {
      stage: 'attempt',
      matchId,
      side: input.side,
      channelId: channel.channelId,
      conversationId: String(conversation._id),
      bodyBytes: Buffer.byteLength(input.body, 'utf8'),
    },
  });

  // Socket send — failure path: persist FAILED row + audit + rethrow
  let externalMessageId: string;
  try {
    externalMessageId = await sendTextFromChannel({
      channelId: channel.channelId,
      jid,
      body: input.body,
    });
  } catch (sendErr) {
    const failedMsg = await MessageModel.create({
      conversationId: conversation._id,
      channelId: channel.channelId,
      channelRole: channel.role,
      accountDisplayName: channel.accountDisplayName,
      direction: MessageDirection.OUTBOUND,
      contentType: 'text',
      body: input.body,
      providerSessionId: channel.providerSessionId ?? channel.channelId,
      deliveryStatus: MessageDeliveryStatus.FAILED,
      failedAt: new Date(),
      failureReason: (sendErr as Error).message,
    });
    await audit({
      entityType: AuditEntityType.MESSAGE,
      entityId: String(failedMsg._id),
      actionType: AuditActionType.MESSAGE_SENT,
      performedBy: input.performedBy,
      metadata: {
        stage: 'failed',
        matchId,
        side: input.side,
        channelId: channel.channelId,
        conversationId: String(conversation._id),
        error: (sendErr as Error).message,
      },
    });
    throw new BusinessRuleError(
      'Send failed: ' + (sendErr as Error).message,
      { code: 'send_failed' },
    );
  }

  // Persist the outbound Message row
  const saved = await MessageModel.create({
    conversationId: conversation._id,
    channelId: channel.channelId,
    channelRole: channel.role,
    accountDisplayName: channel.accountDisplayName,
    direction: MessageDirection.OUTBOUND,
    contentType: 'text',
    body: input.body,
    externalMessageId,
    providerSessionId: channel.providerSessionId ?? channel.channelId,
    deliveryStatus: MessageDeliveryStatus.SENT,
    sentAt: new Date(),
  });

  await ConversationModel.updateOne(
    { _id: conversation._id },
    { $set: { lastMessageAt: saved.createdAt, lastOutboundAt: saved.sentAt } },
  ).exec();

  // Advance the match state machine
  const before = match.toObject();
  const now = new Date();
  if (input.side === 'a') {
    match.sentSideAAt = now;
    match.status = match.sentSideBAt ? MatchSuggestionStatus.SENT_BOTH : MatchSuggestionStatus.SENT_SIDE_A;
  } else {
    match.sentSideBAt = now;
    match.status = match.sentSideAAt ? MatchSuggestionStatus.SENT_BOTH : MatchSuggestionStatus.SENT_SIDE_B;
  }
  await match.save();

  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: matchId,
    actionType: AuditActionType.MATCH_SENT,
    performedBy: input.performedBy,
    before,
    after: match.toObject(),
    metadata: { side: input.side, channelId: channel.channelId, externalMessageId },
  });

  await audit({
    entityType: AuditEntityType.MESSAGE,
    entityId: String(saved._id),
    actionType: AuditActionType.MESSAGE_SENT,
    performedBy: input.performedBy,
    metadata: {
      stage: 'success',
      matchId,
      side: input.side,
      channelId: channel.channelId,
      externalMessageId,
    },
  });

  return {
    messageId: String(saved._id),
    externalMessageId,
    conversationId: String(conversation._id),
    matchStatus: match.status,
  };
}
