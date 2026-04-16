// ═══════════════════════════════════════════════════════════
// Insights summary (Phase 5).
//
// Only numbers we actually have. Built from the same collections
// the rest of the system writes — no synthetic data, no fake
// per-shadchan performance metrics.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import {
  MatchSuggestion,
  Message,
  Task,
  InternalCandidate,
  ExternalCandidate,
} from '../../models/index.js';
import { MatchSuggestionStatus, MessageExtractionStatus, TaskStatus, CandidateStatus, ExternalCandidateStatus } from '@shadchanai/shared';
import { ensureUser } from '../../middleware/permissions.js';
import { ok } from '../../utils/response.js';

interface FunnelBucket {
  key: string;
  label: string;
  count: number;
}

export async function summaryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(req.user);

    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const [
      matchStatusCounts,
      sentThisWeek,
      openTasks,
      needsReview,
      activeInternals,
      datingInternals,
      activeExternals,
    ] = await Promise.all([
      MatchSuggestion.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).exec(),
      MatchSuggestion.countDocuments({
        $or: [
          { sentSideAAt: { $gte: weekAgo } },
          { sentSideBAt: { $gte: weekAgo } },
        ],
      }).exec(),
      Task.countDocuments({ status: TaskStatus.OPEN }).exec(),
      Message.countDocuments({ 'extraction.status': MessageExtractionStatus.NEEDS_REVIEW }).exec(),
      InternalCandidate.countDocuments({ status: CandidateStatus.ACTIVE, archivedAt: { $exists: false } }).exec(),
      InternalCandidate.countDocuments({ status: 'dating' }).exec(),
      ExternalCandidate.countDocuments({ status: ExternalCandidateStatus.ACTIVE, archivedAt: { $exists: false } }).exec(),
    ]);

    const statusMap: Record<string, number> = {};
    for (const row of matchStatusCounts) statusMap[row._id] = row.count;

    const funnel: FunnelBucket[] = [
      {
        key: 'draft',
        label: 'טיוטות',
        count: (statusMap[MatchSuggestionStatus.DRAFT] ?? 0) + (statusMap[MatchSuggestionStatus.PENDING_APPROVAL] ?? 0),
      },
      {
        key: 'approved',
        label: 'אושרו',
        count: statusMap[MatchSuggestionStatus.APPROVED] ?? 0,
      },
      {
        key: 'sent',
        label: 'נשלחו',
        count:
          (statusMap[MatchSuggestionStatus.SENT_SIDE_A] ?? 0)
          + (statusMap[MatchSuggestionStatus.SENT_SIDE_B] ?? 0)
          + (statusMap[MatchSuggestionStatus.SENT_BOTH] ?? 0),
      },
      {
        key: 'accepted',
        label: 'תגובה חיובית',
        count:
          (statusMap[MatchSuggestionStatus.ACCEPTED_SIDE_A] ?? 0)
          + (statusMap[MatchSuggestionStatus.ACCEPTED_SIDE_B] ?? 0)
          + (statusMap[MatchSuggestionStatus.ACCEPTED_BOTH] ?? 0),
      },
      {
        key: 'dating',
        label: 'בהיכרות',
        count: statusMap[MatchSuggestionStatus.DATING] ?? 0,
      },
    ];

    ok(res, {
      funnel,
      counters: {
        activeInternals,
        datingInternals,
        activeExternals,
        sentThisWeek,
        openTasks,
        needsReview,
      },
    });
  } catch (e) { next(e); }
}
