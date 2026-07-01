// ═══════════════════════════════════════════════════════════
// Insights summary service (Phase 5).
//
// Only numbers we actually have. Built from the same collections
// the rest of the system writes — no synthetic data, no fake
// per-shadchan performance metrics.
// ═══════════════════════════════════════════════════════════

import {
  MatchSuggestion,
  Message,
  Task,
  InternalCandidate,
  ExternalCandidate,
} from '../../models/index.js';
import {
  MatchSuggestionStatus,
  MessageExtractionStatus,
  TaskStatus,
  CandidateStatus,
  ExternalCandidateStatus,
} from '@shadchanai/shared';
import { inferGender } from '../../services/extraction/templates.js';

interface FunnelBucket {
  key: string;
  label: string;
  count: number;
}

// Gender split of the active pool. `unknown` counts candidates whose
// gender is missing or unrecognised — these are invisible to (or can
// leak into) matching, so it doubles as a data-quality alarm.
export interface GenderBreakdown {
  male: number;
  female: number;
  unknown: number;
}

export interface InsightsSummary {
  funnel: FunnelBucket[];
  counters: {
    activeInternals: number;
    datingInternals: number;
    activeExternals: number;
    sentThisWeek: number;
    openTasks: number;
    needsReview: number;
  };
  gender: {
    internal: GenderBreakdown; // מאגר פרטי
    external: GenderBreakdown; // מאגר כללי
  };
}

type GenderGroupRow = { _id: string | null; count: number };

function foldGender(rows: GenderGroupRow[]): GenderBreakdown {
  const out: GenderBreakdown = { male: 0, female: 0, unknown: 0 };
  for (const r of rows) {
    if (r._id === 'male') out.male += r.count;
    else if (r._id === 'female') out.female += r.count;
    else out.unknown += r.count; // null / undefined / unexpected value
  }
  return out;
}

export async function getSummary(): Promise<InsightsSummary> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const [
    matchStatusCounts,
    sentThisWeek,
    openTasks,
    needsReview,
    activeInternals,
    datingInternals,
    activeExternals,
    internalGenderRows,
    externalGenderRows,
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
    InternalCandidate.aggregate<GenderGroupRow>([
      { $match: { status: CandidateStatus.ACTIVE, archivedAt: { $exists: false } } },
      { $group: { _id: '$gender', count: { $sum: 1 } } },
    ]).exec(),
    ExternalCandidate.aggregate<GenderGroupRow>([
      { $match: { status: ExternalCandidateStatus.ACTIVE, archivedAt: { $exists: false } } },
      { $group: { _id: '$gender', count: { $sum: 1 } } },
    ]).exec(),
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

  return {
    funnel,
    counters: {
      activeInternals,
      datingInternals,
      activeExternals,
      sentThisWeek,
      openTasks,
      needsReview,
    },
    gender: {
      internal: foldGender(internalGenderRows),
      external: foldGender(externalGenderRows),
    },
  };
}

// ── Suspect-gender detection ─────────────────────────────────
//
// The matching engine only ever pairs opposite genders, so a
// "two boys"-style bad suggestion can only come from a candidate
// whose stored gender is WRONG (e.g. a man auto-tagged female by
// extraction). We re-run the same Hebrew gender heuristic over the
// candidate's OWN self-description and flag rows where a confident
// inference contradicts the stored gender. Conservative on purpose:
// only the candidate's self-text (never "what they're seeking",
// which describes the partner) and a minimum signal weight.

export interface GenderSuspect {
  id: string;
  name: string;
  storedGender: 'male' | 'female';
  inferredGender: 'male' | 'female';
  maleWeight: number;
  femaleWeight: number;
  snippet: string;
}

export interface GenderQuality {
  suspects: GenderSuspect[];
  scanned: number;
  capped: boolean;
}

const SUSPECT_SCAN_CAP = 3000;
const SUSPECT_MIN_WEIGHT = 2;

export async function getGenderQuality(): Promise<GenderQuality> {
  const docs = await ExternalCandidate.find({
    status: ExternalCandidateStatus.ACTIVE,
    archivedAt: { $exists: false },
    // Only a tagged row can be mis-tagged; missing gender is a separate filter.
    gender: { $in: ['male', 'female'] },
  })
    .select('firstName lastName gender about additionalInfo characterNotes currentOccupation')
    .limit(SUSPECT_SCAN_CAP + 1)
    .lean()
    .exec();

  const capped = docs.length > SUSPECT_SCAN_CAP;
  const scan = capped ? docs.slice(0, SUSPECT_SCAN_CAP) : docs;

  const suspects: GenderSuspect[] = [];
  for (const d of scan) {
    const stored = d.gender as 'male' | 'female';
    const text = [d.about, d.additionalInfo, d.characterNotes, d.currentOccupation]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!text) continue;

    const sig = inferGender(text);
    if (!sig.gender || sig.gender === stored) continue;

    const winning = sig.gender === 'male' ? sig.maleWeight : sig.femaleWeight;
    if (winning < SUSPECT_MIN_WEIGHT) continue;

    suspects.push({
      id: String(d._id),
      name: `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim() || 'ללא שם',
      storedGender: stored,
      inferredGender: sig.gender,
      maleWeight: sig.maleWeight,
      femaleWeight: sig.femaleWeight,
      snippet: text.length > 140 ? text.slice(0, 140) + '…' : text,
    });
  }

  return { suspects, scanned: scan.length, capped };
}
