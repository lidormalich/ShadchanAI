// ═══════════════════════════════════════════════════════════
// Dashboard queue (Phase 4).
//
// Assembles the operator's single prioritized action queue by
// querying the existing entity collections in parallel. No new
// collections — strictly a view over matches / tasks /
// conversations / messages. Everything returned is typed via
// the DashboardRow discriminated union in ./dashboard.types.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import {
  MatchSuggestionStatus,
  MessageExtractionStatus,
  TaskStatus,
} from '@shadchanai/shared';
import {
  MatchSuggestion,
  Message,
  Conversation,
  Task,
} from '../../models/index.js';
import {
  DASHBOARD_THRESHOLDS,
  type DashboardRow,
  type DashboardRowType,
  type NeedsReviewRow,
  type AwaitingResponseRow,
  type NewResponseRow,
  type InboundActionRow,
  type OverdueTaskRow,
  type HighPotentialDraftRow,
  type DeferredRecheckRow,
} from './dashboard.types.js';
import { getSettingCached } from '../settings/settings.service.js';

interface BuildQueueInput {
  ownership: 'mine' | 'team' | 'all';
  limit: number;
  type?: DashboardRowType;
  currentUserId: string;
}

const SENT_STATUSES = [
  MatchSuggestionStatus.SENT_SIDE_A,
  MatchSuggestionStatus.SENT_SIDE_B,
  MatchSuggestionStatus.SENT_BOTH,
];

/**
 * "mine" narrows owner-scoped categories (matches, tasks) to rows
 * the current user owns. Categories without an owner field
 * (extraction review, inbound conversations) are operational work
 * that anyone on duty should see; we include them regardless of
 * scope so "mine" never silently hides urgent ops items.
 */
export async function buildDashboardQueue(input: BuildQueueInput): Promise<DashboardRow[]> {
  const { ownership, limit, type, currentUserId } = input;
  const ownerFilter = ownership === 'mine'
    ? { ownerUserId: new Types.ObjectId(currentUserId) }
    : {};

  const want = (t: DashboardRowType): boolean => !type || type === t;

  // Thresholds are runtime-configurable via the Settings collection.
  // Falls back to the hardcoded defaults in dashboard.types when no
  // override is stored, so the queue keeps working out of the box.
  const [awaitHours, highPotMinScore, deferredMinAgeHours] = (await Promise.all([
    getSettingCached('dashboard.awaiting_response_hours'),
    getSettingCached('dashboard.high_potential_min_score'),
    getSettingCached('dashboard.deferred_min_age_hours'),
  ])) as [number, number, number];

  const [
    needsReview,
    awaitingResponse,
    newResponse,
    inboundAction,
    overdueTask,
    highPotential,
    deferredRecheck,
  ] = await Promise.all([
    want('needs_review') ? queryNeedsReview(limit) : [],
    want('awaiting_response') ? queryAwaitingResponse(limit, ownerFilter, awaitHours) : [],
    want('new_response') ? queryNewResponse(limit, ownerFilter, currentUserId) : [],
    want('inbound_action') ? queryInboundAction(limit) : [],
    want('overdue_task') ? queryOverdueTask(limit, ownership, currentUserId) : [],
    want('high_potential_draft') ? queryHighPotential(limit, ownerFilter, highPotMinScore) : [],
    want('deferred_recheck') ? queryDeferredRecheck(limit, ownerFilter, deferredMinAgeHours) : [],
  ]);

  const merged = [
    ...needsReview, ...awaitingResponse, ...newResponse, ...inboundAction,
    ...overdueTask, ...highPotential, ...deferredRecheck,
  ];

  // Sort: urgency tier first, then oldest first within tier (older items
  // jump higher because they've been waiting longer).
  merged.sort((a, b) => {
    if (a.urgencyTier !== b.urgencyTier) return a.urgencyTier - b.urgencyTier;
    return new Date(a.at).getTime() - new Date(b.at).getTime();
  });

  return merged.slice(0, limit);
}

// Dashboard rows only need scalar fields + the response sub-objects. Exclude
// the heavy scoring arrays/objects so we don't ship them over the wire per row.
const DASHBOARD_SUGGESTION_PROJECTION = '-scoreBreakdown -blockers -penalties';

// ── 1. Needs review ─────────────────────────────────────────
async function queryNeedsReview(limit: number): Promise<NeedsReviewRow[]> {
  const items = await Message.find({ 'extraction.status': MessageExtractionStatus.NEEDS_REVIEW })
    .sort({ 'extraction.completedAt': -1 })
    .limit(limit)
    .select('_id conversationId channelId accountDisplayName body extraction createdAt')
    .lean()
    .exec();

  return items.map((m): NeedsReviewRow => ({
    type: 'needs_review',
    id: String(m._id),
    title: snippet(m.body) || 'הודעת פרופיל ממתינה לסקירה',
    context: m.accountDisplayName,
    at: (m.extraction?.completedAt ?? m.createdAt).toISOString(),
    urgencyTier: 5,
    primaryAction: 'פתח לסקירה',
    route: `/review?messageId=${String(m._id)}`,
    messageId: String(m._id),
    conversationId: String(m.conversationId),
    channelId: m.channelId,
    confidence: m.extraction?.confidence,
  }));
}

// ── 2. Awaiting response (SLA breach) ───────────────────────
async function queryAwaitingResponse(
  limit: number,
  ownerFilter: Record<string, unknown>,
  awaitHours: number,
): Promise<AwaitingResponseRow[]> {
  const cutoff = new Date(Date.now() - awaitHours * 3600 * 1000);

  const items = await MatchSuggestion.find({
    ...ownerFilter,
    status: { $in: SENT_STATUSES },
    $or: [
      { sentSideAAt: { $lte: cutoff }, 'sideAResponse.status': 'pending' },
      { sentSideBAt: { $lte: cutoff }, 'sideBResponse.status': 'pending' },
    ],
  })
    .select(DASHBOARD_SUGGESTION_PROJECTION)
    .sort({ sentSideAAt: 1 })
    .limit(limit)
    .lean()
    .exec();

  return items.map((m): AwaitingResponseRow => {
    const aOverdue = m.sentSideAAt && m.sideAResponse?.status === 'pending' && m.sentSideAAt <= cutoff;
    const bOverdue = m.sentSideBAt && m.sideBResponse?.status === 'pending' && m.sentSideBAt <= cutoff;
    const side: 'a' | 'b' | 'both' = aOverdue && bOverdue ? 'both' : aOverdue ? 'a' : 'b';
    const sentAt = side === 'b' ? m.sentSideBAt! : m.sentSideAAt!;
    const hours = Math.floor((Date.now() - sentAt.getTime()) / 3600 / 1000);

    return {
      type: 'awaiting_response',
      id: String(m._id),
      title: `ממתין לתגובה · צד ${side === 'a' ? 'א' : side === 'b' ? 'ב' : 'א+ב'}`,
      context: `${hours} שעות מאז השליחה`,
      at: sentAt.toISOString(),
      ownerUserId: m.ownerUserId ? String(m.ownerUserId) : undefined,
      urgencyTier: 3,
      primaryAction: 'פתח הצעה',
      route: `/matches/${String(m._id)}`,
      matchId: String(m._id),
      matchScore: m.matchScore,
      matchType: m.matchType,
      side,
      internalCandidateId: String(m.internalCandidateId),
      externalCandidateId: String(m.externalCandidateId),
      hoursSinceSent: hours,
    };
  });
}

// ── 3. New response (acknowledge + follow up) ───────────────
//
// A row shows up exactly when a side has a respondedAt that is
// not yet covered by an acknowledgedAt. The operator acknowledges
// by opening the match detail (see MatchDetailPage auto-ack) or
// by calling POST /matches/:id/acknowledge-response explicitly.
// No more 7-day window cheat: the signal is a real persisted flag.
async function queryNewResponse(
  limit: number,
  ownerFilter: Record<string, unknown>,
  _currentUserId: string,
): Promise<NewResponseRow[]> {
  const items = await MatchSuggestion.find({
    ...ownerFilter,
    $or: [
      {
        'sideAResponse.respondedAt': { $exists: true },
        $expr: {
          $or: [
            { $eq: [{ $ifNull: ['$sideAResponse.acknowledgedAt', null] }, null] },
            { $lt: ['$sideAResponse.acknowledgedAt', '$sideAResponse.respondedAt'] },
          ],
        },
      },
      {
        'sideBResponse.respondedAt': { $exists: true },
        $expr: {
          $or: [
            { $eq: [{ $ifNull: ['$sideBResponse.acknowledgedAt', null] }, null] },
            { $lt: ['$sideBResponse.acknowledgedAt', '$sideBResponse.respondedAt'] },
          ],
        },
      },
    ],
  })
    .select(DASHBOARD_SUGGESTION_PROJECTION)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean()
    .exec();

  const rows: NewResponseRow[] = [];
  for (const m of items) {
    const a = m.sideAResponse;
    const b = m.sideBResponse;
    const aUnacked = !!(a?.respondedAt && (!a.acknowledgedAt || a.acknowledgedAt < a.respondedAt));
    const bUnacked = !!(b?.respondedAt && (!b.acknowledgedAt || b.acknowledgedAt < b.respondedAt));
    if (!aUnacked && !bUnacked) continue;
    const pick: 'a' | 'b' = aUnacked && (!bUnacked || (a!.respondedAt! >= b!.respondedAt!)) ? 'a' : 'b';
    const response = pick === 'a' ? a : b;
    if (!response?.respondedAt) continue;

    const convId = pick === 'a' ? m.conversationIds?.sideA : m.conversationIds?.sideB;

    rows.push({
      type: 'new_response',
      id: String(m._id),
      title: `תגובה חדשה · צד ${pick === 'a' ? 'א' : 'ב'}`,
      context: `סטטוס: ${response.status}`,
      at: response.respondedAt.toISOString(),
      ownerUserId: m.ownerUserId ? String(m.ownerUserId) : undefined,
      urgencyTier: 1,
      primaryAction: convId ? 'פתח שיחה' : 'פתח הצעה',
      route: convId ? `/chats?conversation=${String(convId)}` : `/matches/${String(m._id)}`,
      matchId: String(m._id),
      side: pick,
      responseStatus: response.status,
      conversationId: convId ? String(convId) : undefined,
    });
  }
  return rows;
}

// ── 4. Inbound action (conversations needing attention) ─────
async function queryInboundAction(limit: number): Promise<InboundActionRow[]> {
  const items = await Conversation.find({ needsAction: true, isActive: true })
    .sort({ lastInboundAt: -1 })
    .limit(limit)
    .lean()
    .exec();

  return items.map((c): InboundActionRow => ({
    type: 'inbound_action',
    id: String(c._id),
    title: c.participantName ?? 'שיחה חדשה',
    context: c.accountDisplayName,
    at: (c.lastInboundAt ?? c.lastMessageAt ?? c.createdAt).toISOString(),
    urgencyTier: 2,
    primaryAction: 'פתח שיחה',
    route: `/chats?conversation=${String(c._id)}`,
    conversationId: String(c._id),
    channelRole: c.channelRole,
    unreadCount: c.unreadCount ?? 0,
    matchSuggestionId: c.matchSuggestionId ? String(c.matchSuggestionId) : undefined,
  }));
}

// ── 5. Overdue task ─────────────────────────────────────────
async function queryOverdueTask(
  limit: number,
  ownership: 'mine' | 'team' | 'all',
  currentUserId: string,
): Promise<OverdueTaskRow[]> {
  const filter: Record<string, unknown> = {
    status: TaskStatus.OPEN,
    dueAt: { $lt: new Date() },
  };
  if (ownership === 'mine') {
    filter['$or'] = [
      { ownerUserId: new Types.ObjectId(currentUserId) },
      { assignedTo: new Types.ObjectId(currentUserId) },
    ];
  }

  const items = await Task.find(filter).sort({ dueAt: 1 }).limit(limit).lean().exec();

  return items.map((t): OverdueTaskRow => ({
    type: 'overdue_task',
    id: String(t._id),
    title: t.title,
    context: t.description ? t.description.slice(0, 120) : undefined,
    at: (t.dueAt ?? t.createdAt).toISOString(),
    ownerUserId: t.assignedTo
      ? String(t.assignedTo)
      : t.ownerUserId ? String(t.ownerUserId) : undefined,
    urgencyTier: 4,
    primaryAction: 'סמן בוצע',
    route: '/tasks',
    taskId: String(t._id),
    dueAt: (t.dueAt ?? t.createdAt).toISOString(),
    priority: t.priority,
    relatedEntity: {
      internalCandidateId: t.internalCandidateId ? String(t.internalCandidateId) : undefined,
      externalCandidateId: t.externalCandidateId ? String(t.externalCandidateId) : undefined,
      matchSuggestionId: t.matchSuggestionId ? String(t.matchSuggestionId) : undefined,
      conversationId: t.conversationId ? String(t.conversationId) : undefined,
    },
  }));
}

// ── 6. High-potential draft ─────────────────────────────────
async function queryHighPotential(
  limit: number,
  ownerFilter: Record<string, unknown>,
  minScore: number,
): Promise<HighPotentialDraftRow[]> {
  const ageCutoff = new Date(Date.now() - DASHBOARD_THRESHOLDS.HIGH_POTENTIAL_MIN_AGE_HOURS * 3600 * 1000);
  const items = await MatchSuggestion.find({
    ...ownerFilter,
    status: { $in: [MatchSuggestionStatus.DRAFT, MatchSuggestionStatus.PENDING_APPROVAL, MatchSuggestionStatus.APPROVED] },
    matchScore: { $gte: minScore },
    isDeferred: { $ne: true },
    createdAt: { $lte: ageCutoff },
    // not already sent
    sentSideAAt: { $exists: false },
    sentSideBAt: { $exists: false },
  })
    .select(DASHBOARD_SUGGESTION_PROJECTION)
    .sort({ matchScore: -1 })
    .limit(limit)
    .lean()
    .exec();

  return items.map((m): HighPotentialDraftRow => ({
    type: 'high_potential_draft',
    id: String(m._id),
    title: `הצעה בציון גבוה · ${m.matchScore}`,
    context: `${m.matchType} · ממתינה לשליחה`,
    at: m.createdAt.toISOString(),
    ownerUserId: m.ownerUserId ? String(m.ownerUserId) : undefined,
    urgencyTier: 6,
    primaryAction: 'פתח הצעה',
    route: `/matches/${String(m._id)}`,
    matchId: String(m._id),
    matchScore: m.matchScore,
    matchType: m.matchType,
    internalCandidateId: String(m.internalCandidateId),
    externalCandidateId: String(m.externalCandidateId),
  }));
}

// ── 7. Deferred recheck ─────────────────────────────────────
async function queryDeferredRecheck(
  limit: number,
  ownerFilter: Record<string, unknown>,
  deferredMinAgeHours: number,
): Promise<DeferredRecheckRow[]> {
  const cutoff = new Date(Date.now() - deferredMinAgeHours * 3600 * 1000);
  const items = await MatchSuggestion.find({
    ...ownerFilter,
    isDeferred: true,
    deferredAt: { $lte: cutoff },
    status: { $ne: MatchSuggestionStatus.CLOSED },
  })
    .select(DASHBOARD_SUGGESTION_PROJECTION)
    .sort({ deferredAt: 1 })
    .limit(limit)
    .lean()
    .exec();

  return items.map((m): DeferredRecheckRow => ({
    type: 'deferred_recheck',
    id: String(m._id),
    title: 'הצעה מושהית — שווה לבדוק שוב',
    context: m.deferredReason,
    at: (m.deferredAt ?? m.updatedAt).toISOString(),
    ownerUserId: m.ownerUserId ? String(m.ownerUserId) : undefined,
    urgencyTier: 7,
    primaryAction: 'פתח הצעה',
    route: `/matches/${String(m._id)}`,
    matchId: String(m._id),
    deferredAt: (m.deferredAt ?? m.updatedAt).toISOString(),
    deferredReason: m.deferredReason,
  }));
}

function snippet(body?: string): string | undefined {
  if (!body) return undefined;
  const trimmed = body.trim().replace(/\s+/g, ' ');
  return trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed;
}
