// ═══════════════════════════════════════════════════════════
// MatchScanBar — triggers the incremental match scan and surfaces
// its live progress + results.
//
//   • "סרוק הצעות"  → POST /matches/scan {mode:'missing'} — scans only
//      pairs never scored before (X-Y new → scanned; X-Z already done →
//      skipped). Runs in the BACKGROUND on the server.
//   • A progress modal polls GET /matches/scan/state and can be MINIMIZED
//      to a floating chip while the scan keeps running.
//   • "תוצאות הסריקה" → dialog over GET /matches/scan/results with
//      score-trend filters (up / down / new).
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronUp, Loader2, Minus, Search, TrendingDown, TrendingUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Select } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { label } from '@/utils/labels';
import { matchesApi, type ScanResultItem, type ScanState } from '@/services/api/matches';

type ProgressView = 'closed' | 'modal' | 'minimized';

export function MatchScanBar() {
  const qc = useQueryClient();
  const [resultsOpen, setResultsOpen] = useState(false);
  const [view, setView] = useState<ProgressView>('closed');
  const prevStatus = useRef<string | undefined>();

  const state = useQuery({
    queryKey: ['scan-state'],
    queryFn: () => matchesApi.scanState(),
    // Poll while a scan is running so the progress bar advances live.
    refetchInterval: (q) => (q.state.data?.data?.status === 'running' ? 1000 : false),
  });
  const live = state.data?.data ?? null;

  // Fire a toast + refresh the moment a run finishes.
  useEffect(() => {
    const status = live?.status;
    if (prevStatus.current === 'running' && status === 'done' && live) {
      toast.success(
        'הסריקה הושלמה',
        `נסרקו ${live.pairsScored} זוגות · נוצרו ${live.draftsCreated} טיוטות`,
      );
      qc.invalidateQueries({ queryKey: ['scan-results'] });
      qc.invalidateQueries({ queryKey: ['matches'] });
    }
    if (prevStatus.current === 'running' && status === 'error') {
      toast.error('הסריקה נכשלה', live?.lastError ?? '');
    }
    prevStatus.current = status;
  }, [live, qc]);

  const scan = useMutation({
    mutationFn: () => matchesApi.scan({ mode: 'missing' }),
    onSuccess: () => {
      setView('modal');
      qc.invalidateQueries({ queryKey: ['scan-state'] });
    },
    onError: (e) => toast.error('הפעלת הסריקה נכשלה', (e as Error).message),
  });

  const running = live?.status === 'running';

  return (
    <Card className="p-3 flex items-center gap-3 flex-wrap">
      <Button
        leftIcon={<Search className="h-4 w-4" />}
        loading={scan.isPending}
        disabled={running}
        onClick={() => scan.mutate()}
      >
        סרוק הצעות
      </Button>
      <Button variant="secondary" onClick={() => setResultsOpen(true)}>
        תוצאות הסריקה
      </Button>

      {running ? (
        <button
          type="button"
          onClick={() => setView('modal')}
          className="inline-flex items-center gap-1.5 text-xs text-brand-700 hover:underline"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          סורק… {live?.progressCurrent ?? 0}/{live?.progressTotal ?? 0}
        </button>
      ) : (
        <div className="text-xs text-ink-muted">
          {live?.lastScanAt
            ? <>נסרק לאחרונה {new Date(live.lastScanAt).toLocaleString('he-IL')} · {live.improved} השתפרו · {live.declined} ירדו</>
            : 'טרם בוצעה סריקה'}
        </div>
      )}

      {view === 'modal' && live && (
        <ScanProgressModal
          state={live}
          onMinimize={() => setView('minimized')}
          onClose={() => setView('closed')}
        />
      )}
      {view === 'minimized' && running && live && (
        <ScanProgressChip state={live} onExpand={() => setView('modal')} />
      )}

      {resultsOpen && <ScanResultsDialog onClose={() => setResultsOpen(false)} />}
    </Card>
  );
}

function pct(s: ScanState): number {
  if (!s.progressTotal) return s.status === 'done' ? 100 : 0;
  return Math.min(100, Math.round((s.progressCurrent / s.progressTotal) * 100));
}

function ScanProgressModal({
  state, onMinimize, onClose,
}: {
  state: ScanState;
  onMinimize: () => void;
  onClose: () => void;
}) {
  const done = state.status === 'done';
  const p = pct(state);
  return (
    <Dialog
      open={true}
      onClose={onClose}
      title={done ? 'הסריקה הושלמה' : 'סורק התאמות…'}
      description={done
        ? 'הטיוטות שנוצרו מופיעות בעמודת "חדשות" למטה.'
        : 'סורק רק זוגות שטרם נבדקו. אפשר למזער — הסריקה תמשיך ברקע.'}
      primaryAction={done
        ? { label: 'סגור', onClick: onClose }
        : { label: 'מזער', onClick: onMinimize }}
      secondaryAction={done ? undefined : { label: 'הסתר', onClick: onClose }}
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-muted">{state.progressCurrent} / {state.progressTotal} זוגות</span>
          <span className="num font-semibold">{p}%</span>
        </div>
        <div className="h-2 bg-bg-subtle rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${done ? 'bg-emerald-500' : 'bg-brand'}`}
            style={{ width: `${p}%` }}
          />
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <Stat label="טיוטות נוצרו" value={state.draftsCreated} tone="purple" />
          <Stat label="השתפרו" value={state.improved} tone="success" />
          <Stat label="ירדו" value={state.declined} tone="danger" />
        </div>
      </div>
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'purple' | 'success' | 'danger' }) {
  const color = tone === 'purple' ? 'text-purple-700' : tone === 'success' ? 'text-emerald-600' : 'text-red-600';
  return (
    <div className="rounded-md border border-border p-2">
      <div className={`text-lg font-semibold num ${color}`}>{value}</div>
      <div className="text-ink-muted">{label}</div>
    </div>
  );
}

function ScanProgressChip({ state, onExpand }: { state: ScanState; onExpand: () => void }) {
  const p = pct(state);
  return (
    <div className="fixed bottom-4 end-4 z-40 w-60 bg-bg-card border border-border rounded-lg shadow-rise p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-700" /> סורק התאמות…
        </span>
        <button type="button" onClick={onExpand} className="text-ink-faint hover:text-ink">
          <ChevronUp className="h-4 w-4" />
        </button>
      </div>
      <div className="h-1.5 bg-bg-subtle rounded-full overflow-hidden">
        <div className="bg-brand h-full rounded-full transition-all" style={{ width: `${p}%` }} />
      </div>
      <div className="text-[11px] text-ink-muted mt-1 num">{state.progressCurrent}/{state.progressTotal} · {state.draftsCreated} טיוטות</div>
    </div>
  );
}

function ScanResultsDialog({ onClose }: { onClose: () => void }) {
  const [direction, setDirection] = useState('');
  const [eligibleOnly, setEligibleOnly] = useState(true);
  const [minScore, setMinScore] = useState('');

  const q = useQuery({
    queryKey: ['scan-results', { direction, eligibleOnly, minScore }],
    queryFn: () => matchesApi.scanResults({
      direction: direction || undefined,
      eligibleOnly: eligibleOnly || undefined,
      minScore: minScore ? Number(minScore) : undefined,
      limit: 200,
    }),
  });

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title="תוצאות סריקת ההתאמות"
      description="כל הזוגות שנסרקו, עם מגמת הציון לעומת הסריקה הקודמת. סינון לפי שיפור/ירידה בציון."
      secondaryAction={{ label: 'סגור', onClick: onClose }}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="">כל המגמות</option>
            <option value="up">השתפרו ▲</option>
            <option value="down">ירדו ▼</option>
            <option value="new">חדשים</option>
            <option value="same">ללא שינוי</option>
          </Select>
          <Select value={minScore} onChange={(e) => setMinScore(e.target.value)}>
            <option value="">כל הציונים</option>
            <option value="70">70+</option>
            <option value="55">55+</option>
            <option value="40">40+</option>
          </Select>
          <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} className="h-3.5 w-3.5" />
            כשירים בלבד
          </label>
        </div>

        <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
          {q.isLoading ? (
            <LoadingSkeleton rows={6} />
          ) : !q.data?.data.length ? (
            <EmptyState title="אין תוצאות" description="הרץ סריקה או שנה את הסינון." />
          ) : (
            <ul className="divide-y divide-border">
              {q.data.data.map((r) => (
                <ScanResultRow key={`${r.internalCandidateId}:${r.externalCandidateId}`} row={r} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ScanResultRow({ row }: { row: ScanResultItem }) {
  return (
    <li className="py-2.5 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">
          {row.internalName} <span className="text-ink-faint">·</span> {row.externalName}
        </div>
        <div className="text-xs text-ink-muted flex items-center gap-2 flex-wrap">
          <Badge tone={row.matchType === 'safe' ? 'success' : row.matchType === 'balanced' ? 'brand' : 'warning'}>
            {label('matchType', row.matchType)}
          </Badge>
          {row.autoCreated && <Badge tone="purple">טיוטה נוצרה</Badge>}
          {!row.eligible && <Badge tone="danger">חסום</Badge>}
        </div>
      </div>

      <DeltaBadge row={row} />

      <div className="text-end shrink-0 w-12">
        <div className="text-lg font-semibold num text-brand-700">{row.matchScore}</div>
        <div className="text-[11px] text-ink-faint num">ביטחון {row.confidenceScore}</div>
      </div>

      <div className="shrink-0 w-16 text-end">
        {row.matchSuggestionId ? (
          <Link to={`/matches/${row.matchSuggestionId}`} className="text-xs text-brand-700 hover:underline">פתח הצעה</Link>
        ) : (
          <Link to={`/candidates/external/${row.externalCandidateId}`} className="text-xs text-ink-muted hover:underline">פרופיל</Link>
        )}
      </div>
    </li>
  );
}

function DeltaBadge({ row }: { row: ScanResultItem }) {
  if (row.scoreDirection === 'new') {
    return <span className="text-[11px] text-ink-faint shrink-0 w-14 text-center">חדש</span>;
  }
  if (row.scoreDirection === 'up') {
    return (
      <span className="inline-flex items-center gap-0.5 text-emerald-600 text-xs shrink-0 w-14 justify-center">
        <TrendingUp className="h-3.5 w-3.5" /> +{row.scoreDelta}
      </span>
    );
  }
  if (row.scoreDirection === 'down') {
    return (
      <span className="inline-flex items-center gap-0.5 text-red-600 text-xs shrink-0 w-14 justify-center">
        <TrendingDown className="h-3.5 w-3.5" /> {row.scoreDelta}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-ink-faint text-xs shrink-0 w-14 justify-center">
      <Minus className="h-3.5 w-3.5" />
    </span>
  );
}
