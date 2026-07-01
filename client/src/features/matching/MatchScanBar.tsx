// ═══════════════════════════════════════════════════════════
// MatchScanBar — triggers the incremental match scan and surfaces
// its live progress.
//
//   • "סרוק הצעות"  → POST /matches/scan {mode:'missing'} — scans only
//      pairs never scored before (X-Y new → scanned; X-Z already done →
//      skipped). Runs in the BACKGROUND on the server.
//   • A progress modal polls GET /matches/scan/state and can be MINIMIZED
//      to a floating chip while the scan keeps running.
//   • "תיבת ההצעות" → navigates to the dedicated ProposalInboxPage where
//      the scan results are reviewed and decided on.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronUp, Loader2, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button, Card } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { toast } from '@/components/ui/Toast';
import { matchesApi, type ScanState } from '@/services/api/matches';

type ProgressView = 'closed' | 'modal' | 'minimized';

export function MatchScanBar() {
  const qc = useQueryClient();
  const location = useLocation();
  const onInboxPage = location.pathname === '/inbox';
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
        live.draftsCreated > 0
          ? `נסרקו ${live.pairsScored} זוגות · נוצרו ${live.draftsCreated} טיוטות`
          : `נסרקו ${live.pairsScored} זוגות · ההצעות ממתינות בתיבת ההצעות`,
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
      {!onInboxPage && (
        <Link to="/inbox">
          <Button variant="secondary">תיבת ההצעות</Button>
        </Link>
      )}

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
