// ═══════════════════════════════════════════════════════════
// Monitoring aggregation (internal admin only).
//
// Queries existing collections. No new collections. No expensive
// full-collection scans — everything filters by a recent time
// window and uses existing indexes.
// ═══════════════════════════════════════════════════════════

import { AuditActionType, AuditEntityType, MessageExtractionStatus } from '@shadchanai/shared';
import {
  Channel,
  Message,
  MatchSuggestion,
  AuditLog,
} from '../../models/index.js';
import { getCounters, getRecentErrorEvents, type RuntimeErrorEvent } from '../../services/monitoring/metrics.service.js';
import { getSafeModeStatus, type SafeModeStatus } from '../../services/safe-mode/safe-mode.service.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

export interface MonitoringOverview {
  generatedAt: string;
  windowHours: number;
  whatsappSessions: Array<{
    channelId: string;
    role: string;
    status: string;
    connectionHealth: string;
    lastActivityAt?: string;
  }>;
  ingestion: {
    messagesLastHour: number;
    profilesDetected: number;        // CREATED_NEW or MATCHED_EXISTING in window
    profilesSkippedNoText: number;   // SKIPPED_NOT_PROFILE with no_text reason
    duplicatesDetected: number;      // duplicate phone events counter (runtime)
  };
  extraction: {
    successCount: number;            // CREATED_NEW + MATCHED_EXISTING
    failureCount: number;            // FAILED
    reviewQueueSize: number;         // current NEEDS_REVIEW, all-time until approved
  };
  matching: {
    matchesCreated: number;
    blockedCount: number;            // blocked-but-persisted force-created matches
    overrideCount: number;           // forcedOverride = true
    avgScore: number | null;         // among matches created in window
  };
  communication: {
    proposalsSent: number;
    responsesReceived: number;
    acceptedCount: number;
    declinedCount: number;
    consideringCount: number;
  };
  risks: {
    duplicatePhoneEvents: number;
    notOwnerAttempts: number;
    alreadySendingErrors: number;
    forceMatchCount: number;         // MATCH_FORCED audit rows in window
    sendBlockedSafeModeCount: number; // SEND_BLOCKED_SAFE_MODE rows in window
  };
  safeMode: SafeModeStatus;
  alerts: {
    highDuplicateRate: boolean;
    highReviewQueue: boolean;
    noResponses: boolean;
    manyNotOwnerAttempts: boolean;
    safeModeActive: boolean; // not an "alarm" — informational, but always shown
  };
}

export async function buildOverview(windowHours = 24): Promise<MonitoringOverview> {
  const now = Date.now();
  const windowMs = windowHours * ONE_HOUR_MS;
  const windowStart = new Date(now - windowMs);
  const oneHourAgo = new Date(now - ONE_HOUR_MS);

  const [
    channels,
    messagesLastHour,
    extractionBuckets,
    reviewQueueSize,
    matchAgg,
    forcedCount,
    sentInWindow,
    responseAgg,
    skippedNoText,
  ] = await Promise.all([
    Channel.find({}).select('channelId role status connectionHealth lastConnectedAt lastInboundAt lastOutboundAt').lean().exec(),
    Message.countDocuments({ createdAt: { $gte: oneHourAgo } }).exec(),
    Message.aggregate<{ _id: string; count: number }>([
      { $match: { 'extraction.completedAt': { $gte: windowStart } } },
      { $group: { _id: '$extraction.status', count: { $sum: 1 } } },
    ]).exec(),
    Message.countDocuments({ 'extraction.status': MessageExtractionStatus.NEEDS_REVIEW }).exec(),
    MatchSuggestion.aggregate<{ _id: null; created: number; totalScore: number; forced: number }>([
      { $match: { createdAt: { $gte: windowStart } } },
      { $group: {
          _id: null,
          created: { $sum: 1 },
          totalScore: { $sum: '$matchScore' },
          forced: { $sum: { $cond: [{ $eq: ['$forcedOverride', true] }, 1, 0] } },
      } },
    ]).exec(),
    AuditLog.countDocuments({
      entityType: AuditEntityType.MATCH_SUGGESTION,
      actionType: AuditActionType.MATCH_FORCED,
      createdAt: { $gte: windowStart },
    }).exec(),
    MatchSuggestion.countDocuments({
      $or: [
        { sentSideAAt: { $gte: windowStart } },
        { sentSideBAt: { $gte: windowStart } },
      ],
    }).exec(),
    MatchSuggestion.aggregate<{
      _id: null;
      responded: number;
      accepted: number;
      declined: number;
      considering: number;
    }>([
      {
        $match: {
          $or: [
            { 'sideAResponse.respondedAt': { $gte: windowStart } },
            { 'sideBResponse.respondedAt': { $gte: windowStart } },
          ],
        },
      },
      {
        $project: {
          sideAResponded: { $cond: [{ $gte: ['$sideAResponse.respondedAt', windowStart] }, 1, 0] },
          sideBResponded: { $cond: [{ $gte: ['$sideBResponse.respondedAt', windowStart] }, 1, 0] },
          sideAAccepted: { $cond: [{ $and: [
            { $gte: ['$sideAResponse.respondedAt', windowStart] },
            { $eq: ['$sideAResponse.status', 'accepted'] }] }, 1, 0] },
          sideBAccepted: { $cond: [{ $and: [
            { $gte: ['$sideBResponse.respondedAt', windowStart] },
            { $eq: ['$sideBResponse.status', 'accepted'] }] }, 1, 0] },
          sideADeclined: { $cond: [{ $and: [
            { $gte: ['$sideAResponse.respondedAt', windowStart] },
            { $eq: ['$sideAResponse.status', 'declined'] }] }, 1, 0] },
          sideBDeclined: { $cond: [{ $and: [
            { $gte: ['$sideBResponse.respondedAt', windowStart] },
            { $eq: ['$sideBResponse.status', 'declined'] }] }, 1, 0] },
          sideAConsidering: { $cond: [{ $and: [
            { $gte: ['$sideAResponse.respondedAt', windowStart] },
            { $eq: ['$sideAResponse.status', 'considering'] }] }, 1, 0] },
          sideBConsidering: { $cond: [{ $and: [
            { $gte: ['$sideBResponse.respondedAt', windowStart] },
            { $eq: ['$sideBResponse.status', 'considering'] }] }, 1, 0] },
        },
      },
      {
        $group: {
          _id: null,
          responded: { $sum: { $add: ['$sideAResponded', '$sideBResponded'] } },
          accepted: { $sum: { $add: ['$sideAAccepted', '$sideBAccepted'] } },
          declined: { $sum: { $add: ['$sideADeclined', '$sideBDeclined'] } },
          considering: { $sum: { $add: ['$sideAConsidering', '$sideBConsidering'] } },
        },
      },
    ]).exec(),
    Message.countDocuments({
      'extraction.status': MessageExtractionStatus.SKIPPED_NOT_PROFILE,
      'extraction.failureReason': 'no_text',
      'extraction.completedAt': { $gte: windowStart },
    }).exec(),
  ]);

  const bucketMap = Object.fromEntries(extractionBuckets.map((b) => [b._id, b.count]));
  const successCount =
    (bucketMap[MessageExtractionStatus.CREATED_NEW] ?? 0) +
    (bucketMap[MessageExtractionStatus.MATCHED_EXISTING] ?? 0);
  const failureCount = bucketMap[MessageExtractionStatus.FAILED] ?? 0;
  const profilesDetected = successCount;

  const safeMode = await getSafeModeStatus();
  const matchRow = matchAgg[0];
  const matchesCreated = matchRow?.created ?? 0;
  const overrideCount = matchRow?.forced ?? 0;
  const avgScore = matchesCreated > 0 ? Math.round((matchRow!.totalScore / matchesCreated) * 10) / 10 : null;

  // "blockedCount" = matches created in the window that retain at
  // least one hard blocker (i.e. were force-created past blockers).
  const blockedCount = await MatchSuggestion.countDocuments({
    createdAt: { $gte: windowStart },
    'blockers.0': { $exists: true },
  }).exec();

  const respRow = responseAgg[0] ?? { responded: 0, accepted: 0, declined: 0, considering: 0 };
  const counters = getCounters();

  const overview: MonitoringOverview = {
    generatedAt: new Date().toISOString(),
    windowHours,
    whatsappSessions: channels.map((c) => ({
      channelId: c.channelId,
      role: c.role,
      status: c.status,
      connectionHealth: c.connectionHealth,
      lastActivityAt: (c.lastInboundAt ?? c.lastOutboundAt ?? c.lastConnectedAt)?.toISOString(),
    })),
    ingestion: {
      messagesLastHour,
      profilesDetected,
      profilesSkippedNoText: skippedNoText,
      duplicatesDetected: counters.duplicatePhoneEvents,
    },
    extraction: {
      successCount,
      failureCount,
      reviewQueueSize,
    },
    matching: {
      matchesCreated,
      blockedCount,
      overrideCount,
      avgScore,
    },
    communication: {
      proposalsSent: sentInWindow,
      responsesReceived: respRow.responded,
      acceptedCount: respRow.accepted,
      declinedCount: respRow.declined,
      consideringCount: respRow.considering,
    },
    risks: {
      duplicatePhoneEvents: counters.duplicatePhoneEvents,
      notOwnerAttempts: counters.notOwnerAttempts,
      alreadySendingErrors: counters.alreadySendingErrors,
      forceMatchCount: forcedCount,
      sendBlockedSafeModeCount: counters.sendBlockedSafeModeCount,
    },
    safeMode,
    alerts: {
      highDuplicateRate: counters.duplicatePhoneEvents >= 10,
      highReviewQueue: reviewQueueSize >= 20,
      // Only alarm "no responses" when there was real outbound
      // activity in the window AND outbound is currently enabled.
      // Safe-mode quiet is not an alarm; it's expected.
      noResponses: safeMode.outboundEnabled && sentInWindow >= 5 && respRow.responded === 0,
      manyNotOwnerAttempts: counters.notOwnerAttempts >= 5,
      safeModeActive: !safeMode.outboundEnabled,
    },
  };

  return overview;
}

// ── Event stream ─────────────────────────────────────────

export interface MonitoringEvent {
  type: 'MATCH_CREATED' | 'PROPOSAL_SENT' | 'RESPONSE_DETECTED' | 'FORCE_MATCH' | 'SEND_BLOCKED' | 'ERROR';
  timestamp: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export async function buildRecentEvents(limit = 100): Promise<MonitoringEvent[]> {
  const auditCap = Math.min(limit, 100);
  const rows = await AuditLog.find({
    $or: [
      { entityType: AuditEntityType.MATCH_SUGGESTION, actionType: { $in: [
        AuditActionType.CREATE,
        AuditActionType.MATCH_SENT,
        AuditActionType.RESPONSE_DETECTED,
        AuditActionType.MATCH_FORCED,
        AuditActionType.SEND_BLOCKED_SAFE_MODE,
      ] } },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(auditCap)
    .select('entityId actionType createdAt metadata')
    .lean()
    .exec();

  const auditEvents: MonitoringEvent[] = rows.map((r) => ({
    type: mapAuditToEventType(r.actionType as AuditActionType),
    timestamp: r.createdAt.toISOString(),
    entityId: String(r.entityId),
    metadata: (r.metadata as Record<string, unknown> | undefined) ?? undefined,
  }));

  const errorEvents: MonitoringEvent[] = getRecentErrorEvents(limit).map((e: RuntimeErrorEvent) => ({
    type: 'ERROR',
    timestamp: e.at,
    metadata: { kind: e.kind, ...(e.metadata ?? {}) },
  }));

  const merged = [...auditEvents, ...errorEvents]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);

  return merged;
}

function mapAuditToEventType(action: AuditActionType): MonitoringEvent['type'] {
  switch (action) {
    case AuditActionType.CREATE: return 'MATCH_CREATED';
    case AuditActionType.MATCH_SENT: return 'PROPOSAL_SENT';
    case AuditActionType.RESPONSE_DETECTED: return 'RESPONSE_DETECTED';
    case AuditActionType.MATCH_FORCED: return 'FORCE_MATCH';
    case AuditActionType.SEND_BLOCKED_SAFE_MODE: return 'SEND_BLOCKED';
    default: return 'MATCH_CREATED';
  }
}
