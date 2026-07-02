// ═══════════════════════════════════════════════════════════
// ProposalInboxPage — "תיבת ההצעות"
//
// A dedicated, prominent home for proposals the scan surfaces, split
// into three decision tabs:
//   • ממתינות (pending)   → awaiting a decision. Per row: מתאים / שהייה / דחה.
//   • בשהייה  (held)      → parked as review_later. Can be promoted, dropped,
//                           or returned to the pending tab.
//   • נדחו    (rejected)  → marked not_suitable. Can be reconsidered.
//
// Decisions map onto the existing pair-review states:
//   מתאים → createManual (draft in pipeline) · שהייה → review_later ·
//   דחה → not_suitable · החזר לתיבה → clear the review.
//
// Replaces the old cramped ScanResultsDialog modal in MatchScanBar.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Clock, Inbox, Minus, RotateCcw, TrendingDown, TrendingUp, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Select } from '@/components/ui/primitives';
import { EmptyState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { label, matchTypeTone } from '@/utils/labels';
import { matchesApi, type ScanResultItem } from '@/services/api/matches';
import { pairReviewsApi } from '@/services/api/pair-reviews';
import { MatchScanBar } from '@/features/matching/MatchScanBar';

type TabId = 'inbox' | 'review_later' | 'rejected';

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'inbox',        label: 'ממתינות', icon: <Inbox className="h-4 w-4" /> },
  { id: 'review_later', label: 'בשהייה',  icon: <Clock className="h-4 w-4" /> },
  { id: 'rejected',     label: 'נדחו',    icon: <X className="h-4 w-4" /> },
];

export function ProposalInboxPage() {
  const [tab, setTab] = useState<TabId>('inbox');
  const [direction, setDirection] = useState('');
  const [minScore, setMinScore] = useState('');

  // One query per tab so each tab's count badge stays live regardless of
  // which tab is open. Filters apply across all tabs.
  const queries = {
    inbox: useTabQuery('inbox', direction, minScore),
    review_later: useTabQuery('review_later', direction, minScore),
    rejected: useTabQuery('rejected', direction, minScore),
  };
  const active = queries[tab];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">תיבת ההצעות</h2>
        <p className="text-sm text-ink-muted">
          הצעות שהמערכת מצאה וממתינות להחלטה שלך. לכל הצעה: <b>מתאים</b> → נכנס לצנרת כטיוטה ·
          <b> שהייה</b> → להחליט אחר כך · <b>דחה</b> → לא יוצע שוב.
        </p>
      </div>

      <MatchScanBar />

      {/* Tabs with live counts */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <TabButton
            key={t.id}
            active={tab === t.id}
            onClick={() => setTab(t.id)}
            icon={t.icon}
            count={queries[t.id].data?.data.length}
          >
            {t.label}
          </TabButton>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={direction} onChange={(e) => setDirection(e.target.value)} className="w-auto">
          <option value="">כל המגמות</option>
          <option value="up">השתפרו ▲</option>
          <option value="down">ירדו ▼</option>
          <option value="new">חדשים</option>
          <option value="same">ללא שינוי</option>
        </Select>
        <Select value={minScore} onChange={(e) => setMinScore(e.target.value)} className="w-auto">
          <option value="">כל הציונים</option>
          <option value="70">70+</option>
          <option value="55">55+</option>
          <option value="40">40+</option>
        </Select>
      </div>

      {active.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : !active.data?.data.length ? (
        <EmptyState
          icon={<Inbox className="h-10 w-10 text-ink-faint" />}
          title={tab === 'inbox' ? 'התיבה ריקה' : tab === 'review_later' ? 'אין הצעות בשהייה' : 'אין הצעות שנדחו'}
          description={tab === 'inbox' ? 'הרץ סריקה, או שכל ההצעות כבר טופלו.' : 'אין כאן הצעות כרגע.'}
        />
      ) : (
        <Card className="p-0 overflow-hidden">
          <ul className="divide-y divide-border">
            {active.data.data.map((r) => (
              <ProposalRow key={`${r.internalCandidateId}:${r.externalCandidateId}`} row={r} tab={tab} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function useTabQuery(view: TabId, direction: string, minScore: string) {
  return useQuery({
    queryKey: ['scan-results', view, { direction, minScore }],
    queryFn: () => matchesApi.scanResults({
      view,
      direction: direction || undefined,
      eligibleOnly: true,
      minScore: minScore ? Number(minScore) : undefined,
      limit: 200,
    }),
  });
}

function TabButton({ active, onClick, icon, count, children }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active ? 'border-brand text-brand' : 'border-transparent text-ink-muted hover:text-ink'
      }`}
    >
      {icon}
      {children}
      {count !== undefined && count > 0 && (
        <Badge tone={active ? 'brand' : 'neutral'}>{count}</Badge>
      )}
    </button>
  );
}

function ProposalRow({ row, tab }: { row: ScanResultItem; tab: TabId }) {
  const qc = useQueryClient();

  // Refresh every tab + the pipeline after any decision so counts stay correct.
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['scan-results'] });
    qc.invalidateQueries({ queryKey: ['matches'] });
  };

  const accept = useMutation({
    mutationFn: () => matchesApi.createManual({
      internalCandidateId: row.internalCandidateId,
      externalCandidateId: row.externalCandidateId,
      mode: 'discovery',
    }),
    onSuccess: () => { toast.success('ההצעה התקבלה', 'נוצרה טיוטה בצנרת'); refresh(); },
    onError: (e) => toast.error('הקבלה נכשלה', (e as Error).message),
  });

  const hold = useMutation({
    mutationFn: () => pairReviewsApi.upsert(row.internalCandidateId, row.externalCandidateId, {
      manualStatus: 'review_later',
      operatorReason: 'הושהה מתיבת ההצעות',
    }),
    onSuccess: () => { toast.success('ההצעה הושהתה', 'תופיע בטאב "בשהייה"'); refresh(); },
    onError: (e) => toast.error('ההשהיה נכשלה', (e as Error).message),
  });

  const dismiss = useMutation({
    mutationFn: () => pairReviewsApi.upsert(row.internalCandidateId, row.externalCandidateId, {
      manualStatus: 'not_suitable',
      operatorReason: 'נדחה מתיבת ההצעות',
    }),
    onSuccess: () => { toast.success('ההצעה נדחתה', 'לא תוצע שוב'); refresh(); },
    onError: (e) => toast.error('הדחייה נכשלה', (e as Error).message),
  });

  const restore = useMutation({
    mutationFn: () => pairReviewsApi.clear(row.internalCandidateId, row.externalCandidateId),
    onSuccess: () => { toast.success('הוחזר לתיבה', 'ההצעה שוב ממתינה להחלטה'); refresh(); },
    onError: (e) => toast.error('ההחזרה נכשלה', (e as Error).message),
  });

  const busy = accept.isPending || hold.isPending || dismiss.isPending || restore.isPending;

  const hasReasons = (row.strengths?.length ?? 0) > 0 || (row.attentionPoints?.length ?? 0) > 0;

  return (
    <li className="py-2.5 px-3">
      <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">
          {row.internalName} <span className="text-ink-faint">·</span> {row.externalName}
        </div>
        <div className="text-xs text-ink-muted flex items-center gap-2 flex-wrap mt-0.5">
          <Badge tone={matchTypeTone(row.matchType)}>{label('matchType', row.matchType)}</Badge>
          <DeltaBadge row={row} />
          {row.ageOutOfRange && (
            <Badge tone="warning" icon={<AlertTriangle className="h-3 w-3" />}
              title="הגיל חורג מטווח ההעדפה של אחד הצדדים (מעבר ל±1 שנה). ההצעה עדיין מוצגת — ההחלטה שלך.">
              חריגת גיל
            </Badge>
          )}
        </div>
        {tab !== 'inbox' && row.reviewReason && (
          <div className="text-xs text-ink-faint mt-1 truncate" title={row.reviewReason}>
            <span className="text-ink-muted">סיבה:</span> {row.reviewReason}
          </div>
        )}
      </div>

      <div className="text-end shrink-0 w-12">
        <div className="text-lg font-semibold num text-brand-700">{row.matchScore}</div>
        <div className="text-[11px] text-ink-faint num">ביטחון {row.confidenceScore}</div>
      </div>

      <div className="shrink-0 flex items-center gap-1.5">
        <Button size="sm" loading={accept.isPending} disabled={busy}
          onClick={() => accept.mutate()} leftIcon={<Check className="h-3.5 w-3.5" />}>
          מתאים
        </Button>

        {/* Hide the "שהייה" action while already in the held tab. */}
        {tab !== 'review_later' && (
          <Button size="sm" variant="secondary" loading={hold.isPending} disabled={busy}
            onClick={() => hold.mutate()} leftIcon={<Clock className="h-3.5 w-3.5" />}>
            שהייה
          </Button>
        )}

        {/* Hide the "דחה" action while already in the rejected tab. */}
        {tab !== 'rejected' && (
          <Button size="sm" variant="ghost" loading={dismiss.isPending} disabled={busy}
            onClick={() => dismiss.mutate()} leftIcon={<X className="h-3.5 w-3.5" />}>
            דחה
          </Button>
        )}

        {/* Held / rejected rows can be returned to the pending inbox. */}
        {tab !== 'inbox' && (
          <Button size="sm" variant="ghost" loading={restore.isPending} disabled={busy}
            onClick={() => restore.mutate()} leftIcon={<RotateCcw className="h-3.5 w-3.5" />}>
            החזר
          </Button>
        )}

        <Link to={`/candidates/external/${row.externalCandidateId}`} className="text-xs text-ink-muted hover:underline">
          פרופיל
        </Link>
      </div>
      </div>

      {hasReasons && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <ReasonColumn tone="pos" title="למה מתאים" items={row.strengths} />
          <ReasonColumn tone="neg" title="הפערים" items={row.attentionPoints} />
        </div>
      )}
    </li>
  );
}

function ReasonColumn({ title, items, tone }: {
  title: string;
  items?: string[];
  tone: 'pos' | 'neg';
}) {
  const titleColor = tone === 'pos' ? 'text-emerald-700' : 'text-amber-700';
  const dotColor = tone === 'pos' ? 'bg-emerald-500' : 'bg-amber-500';
  return (
    <div className="rounded-md border border-border bg-bg-subtle p-2">
      <div className={`text-[11px] font-semibold mb-1 ${titleColor}`}>{title}</div>
      {items?.length ? (
        <ul className="space-y-0.5">
          {items.slice(0, 3).map((t, i) => (
            <li key={i} className="text-xs text-ink-muted flex gap-1.5 items-start">
              <span className={`mt-1.5 h-1 w-1 rounded-full shrink-0 ${dotColor}`} />
              <span className="min-w-0">{t}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-xs text-ink-faint">—</div>
      )}
    </div>
  );
}

function DeltaBadge({ row }: { row: ScanResultItem }) {
  if (row.scoreDirection === 'new') {
    return <span className="text-[11px] text-ink-faint">חדש</span>;
  }
  if (row.scoreDirection === 'up') {
    return (
      <span className="inline-flex items-center gap-0.5 text-emerald-600 text-xs">
        <TrendingUp className="h-3.5 w-3.5" /> +{row.scoreDelta}
      </span>
    );
  }
  if (row.scoreDirection === 'down') {
    return (
      <span className="inline-flex items-center gap-0.5 text-red-600 text-xs">
        <TrendingDown className="h-3.5 w-3.5" /> {row.scoreDelta}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-ink-faint text-xs">
      <Minus className="h-3.5 w-3.5" />
    </span>
  );
}
