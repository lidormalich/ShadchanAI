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

import { Types } from 'mongoose';
import {
  AuditActionType,
  AuditEntityType,
  ChannelRole as ChannelRoleEnum,
  MatchSuggestionStatus,
  MessageDirection,
  MessageDeliveryStatus,
} from '@shadchanai/shared';
import {
  MatchSuggestion,
  Message as MessageModel,
  Conversation as ConversationModel,
  Channel as ChannelModel,
} from '../../models/index.js';
import { audit } from '../../services/audit.service.js';
import { BusinessRuleError } from '../../utils/errors.js';
import { assertOwnership } from '../../utils/ownership.assert.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';
import { recordAlreadySending, recordSendBlockedSafeMode } from '../../services/monitoring/metrics.service.js';
import { getSafeModeStatus } from '../../services/safe-mode/safe-mode.service.js';
import { phoneToJid, sendTextFromChannel } from '../../services/whatsapp/whatsapp.service.js';
import { checkAndConsumeSendQuota } from '../../services/whatsapp/send.rate-limiter.js';
import { getMatchById } from './match.query.js';
import { previewSendReadiness } from './match.scoring.js';
import { publishMatchUpdate } from './match.events.js';

export interface SendProposalInput {
  side: 'a' | 'b';
  channelId: string;
  body: string;
  performedBy: string;
  actor?: AuthUser;
}

// A send-in-flight claim older than this is considered stale and
// can be taken over (prior request presumably crashed or timed out).
const SEND_LOCK_STALE_MS = 30_000;

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
  // ── PRE-PILOT SAFE MODE GATE ─────────────────────────
  // Runs FIRST, before any state mutation, claim, or audit
  // that would suggest a real send happened. If outbound is
  // disabled we write a non-destructive audit row so the
  // attempt is visible in monitoring/events, then throw.
  const safeMode = await getSafeModeStatus();
  if (!safeMode.outboundEnabled) {
    recordSendBlockedSafeMode({ matchId, side: input.side, performedBy: input.performedBy });
    await audit({
      entityType: AuditEntityType.MATCH_SUGGESTION,
      entityId: matchId,
      actionType: AuditActionType.SEND_BLOCKED_SAFE_MODE,
      performedBy: input.performedBy,
      metadata: {
        side: input.side,
        channelId: input.channelId,
        reason: safeMode.reason,
        envEnabled: safeMode.envEnabled,
        settingEnabled: safeMode.settingEnabled,
      },
    });
    throw new BusinessRuleError(
      'Safe mode active — outbound WhatsApp sending is disabled. No message was sent and the match status was NOT advanced.',
      {
        code: 'safe_mode_outbound_disabled',
        envEnabled: safeMode.envEnabled,
        settingEnabled: safeMode.settingEnabled,
        reason: safeMode.reason,
      },
    );
  }

  const preview = await previewSendReadiness(matchId);
  if (!preview.canSend) {
    throw new BusinessRuleError(
      'Match is not ready to send: ' + preview.blockers.join('; '),
      { code: 'not_ready_to_send', blockers: preview.blockers },
    );
  }

  const match = await getMatchById(matchId);
  if (input.actor) assertOwnership(match.ownerUserId, input.actor, { entity: 'match suggestion' });

  if (input.side === 'a' && match.sentSideAAt) {
    throw new BusinessRuleError('Side A has already received this proposal', { code: 'already_sent_side_a' });
  }
  if (input.side === 'b' && match.sentSideBAt) {
    throw new BusinessRuleError('Side B has already received this proposal', { code: 'already_sent_side_b' });
  }

  // Atomic claim: prevent double-sends from concurrent requests.
  // This replaces the non-atomic check above as the CANONICAL gate.
  // findOneAndUpdate returns null when another request has already
  // claimed the slot; we surface that as a 422 with a specific code
  // so the UI knows to refetch the match, not to retry blindly.
  const sentField = input.side === 'a' ? 'sentSideAAt' : 'sentSideBAt';
  const inFlightField = input.side === 'a' ? 'sendInFlightSideA' : 'sendInFlightSideB';
  const staleCutoff = new Date(Date.now() - SEND_LOCK_STALE_MS);
  const claim = await MatchSuggestion.findOneAndUpdate(
    {
      _id: match._id,
      [sentField]: { $exists: false },
      $or: [
        { [inFlightField]: { $exists: false } },
        { [inFlightField]: null },
        { [inFlightField]: { $lte: staleCutoff } },
      ],
    },
    { $set: { [inFlightField]: new Date() } },
    { new: true },
  ).exec();
  if (!claim) {
    recordAlreadySending({ matchId, side: input.side, performedBy: input.performedBy });
    throw new BusinessRuleError(
      `Side ${input.side.toUpperCase()} is already being sent or has been sent`,
      { code: `already_sending_side_${input.side}` },
    );
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
    // Release the claim so a future retry with a valid conversation
    // isn't blocked by our own stale in-flight lock.
    await MatchSuggestion.updateOne({ _id: match._id }, { $unset: { [inFlightField]: 1 } }).exec();
    throw new BusinessRuleError(
      'No reachable conversation on channel ' + channel.channelId + ' for side ' + input.side.toUpperCase(),
      { code: 'no_conversation_for_side' },
    );
  }

  // Pre-link BOTH directions BEFORE sending so a very fast recipient
  // reply (arriving between our send and its post-save update)
  // already finds the linkage and gets classified correctly.
  //   - conversation.matchSuggestionId  (so response auto-detection hits)
  //   - match.conversationIds[side]     (so side resolution works)
  // Both are safe on send failure because they only describe bindings,
  // not lifecycle state.
  if (!conversation.matchSuggestionId) {
    await ConversationModel.updateOne(
      { _id: conversation._id, matchSuggestionId: { $exists: false } },
      { $set: { matchSuggestionId: match._id } },
    ).exec();
  }
  const conversationIdsField = input.side === 'a'
    ? 'conversationIds.sideA'
    : 'conversationIds.sideB';
  await MatchSuggestion.updateOne(
    { _id: match._id, [conversationIdsField]: { $exists: false } },
    { $set: { [conversationIdsField]: conversation._id } },
  ).exec();

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
    // Release the in-flight claim so the operator can retry.
    await MatchSuggestion.updateOne({ _id: match._id }, { $unset: { [inFlightField]: 1 } }).exec();
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

  // Advance the match state machine and record the linked conversation
  // so match ↔ conversation navigation works from either direction.
  const before = match.toObject();
  const now = new Date();
  if (input.side === 'a') {
    match.sentSideAAt = now;
    match.status = match.sentSideBAt ? MatchSuggestionStatus.SENT_BOTH : MatchSuggestionStatus.SENT_SIDE_A;
  } else {
    match.sentSideBAt = now;
    match.status = match.sentSideAAt ? MatchSuggestionStatus.SENT_BOTH : MatchSuggestionStatus.SENT_SIDE_B;
  }
  match.conversationIds = match.conversationIds ?? {};
  if (input.side === 'a') match.conversationIds.sideA = conversation._id as Types.ObjectId;
  else match.conversationIds.sideB = conversation._id as Types.ObjectId;
  match.markModified('conversationIds');
  // Clear the in-flight claim as part of the same save.
  if (input.side === 'a') match.sendInFlightSideA = undefined;
  else match.sendInFlightSideB = undefined;
  await match.save();

  // Back-link the conversation to the match if not already linked.
  if (!conversation.matchSuggestionId) {
    await ConversationModel.updateOne(
      { _id: conversation._id },
      { $set: { matchSuggestionId: match._id } },
    ).exec();
  }

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

  publishMatchUpdate(match, 'sent', { side: input.side, conversationId: String(conversation._id) });

  return {
    messageId: String(saved._id),
    externalMessageId,
    conversationId: String(conversation._id),
    matchStatus: match.status,
  };
}
