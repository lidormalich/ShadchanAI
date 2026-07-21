// ═══════════════════════════════════════════════════════════
// BlockedCandidatesList — shows pairs the engine rejected,
// grouped by overridable severity, with a "force with reason"
// path for overridable-only rows.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, ShieldAlert } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Textarea } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { Dialog } from '@/components/ui/Dialog';
import { toast } from '@/components/ui/Toast';
import { matchesApi } from '@/services/api/matches';
import { label } from '@/utils/labels';
import type { BlockedMatchItem, BlockerReason } from '@/types/domain';

const SEVERITY_TONE: Record<BlockerReason['severity'], 'danger' | 'warning' | 'neutral'> = {
  hard_non_overridable: 'danger',
  hard_overridable: 'warning',
  soft_warning: 'neutral',
};

const SEVERITY_LABEL: Record<BlockerReason['severity'], string> = {
  hard_non_overridable: 'חסום',
  hard_overridable: 'חסום — ניתן לעקוף עם נימוק',
  soft_warning: 'אזהרה',
};

export function BlockedCandidatesList({
  internalCandidateId,
  enabled,
}: {
  internalCandidateId: string;
  enabled: boolean;
}) {
  const q = useQuery({
    queryKey: ['find-blocked', internalCandidateId, enabled],
    queryFn: () => matchesApi.findBlockedForInternal(internalCandidateId, { limit: 50 }),
    enabled,
  });

  const [forceTarget, setForceTarget] = useState<BlockedMatchItem | null>(null);

  if (q.isLoading) return <LoadingSkeleton rows={4} />;
  if (q.isError) return <ErrorState description={(q.error as Error).message} onRetry={() => q.refetch()} />;
  const rows = q.data?.data ?? [];
  if (rows.length === 0) {
    return <EmptyState title="אין חסימות להציג" description="אין מועמדים חיצוניים שהמנוע חסם עבור מועמד זה." />;
  }

  return (
    <>
      <ul className="space-y-2">
        <BlockedRowList rows={rows} onForce={setForceTarget} />
      </ul>

      <ForceMatchDialog
        internalCandidateId={internalCandidateId}
        target={forceTarget}
        onClose={() => setForceTarget(null)}
      />
    </>
  );
}

// Sort + render lives in its own component so the useMemo hook sits above any
// early return in the parent (hooks rules) and rows only re-sort when they change.
function BlockedRowList({
  rows,
  onForce,
}: {
  rows: BlockedMatchItem[];
  onForce: (row: BlockedMatchItem) => void;
}) {
  // Group: force-allowed first, then force-blocked.
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (a.aggregateOverridable === b.aggregateOverridable) return 0;
        return a.aggregateOverridable === 'with_reason' ? -1 : 1;
      }),
    [rows],
  );
  return (
    <>
      {sorted.map((row) => (
        <BlockedRow key={row.externalCandidateId} row={row} onForce={onForce} />
      ))}
    </>
  );
}

const BlockedRow = memo(function BlockedRow({
  row,
  onForce,
}: {
  row: BlockedMatchItem;
  onForce: (row: BlockedMatchItem) => void;
}) {
  const name = `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() || 'ללא שם';
  const forceAllowed = row.aggregateOverridable === 'with_reason';

  return (
    <li className="rounded-md border border-border bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-medium truncate">{name}</div>
            {forceAllowed
              ? <Badge tone="warning"><ShieldAlert className="h-3 w-3 ms-1 inline" /> ניתן לעקוף</Badge>
              : <Badge tone="danger"><Lock className="h-3 w-3 ms-1 inline" /> חסימה קשה</Badge>}
            {row.sectorGroup && <Badge tone="neutral">{label('sectorGroup', row.sectorGroup)}</Badge>}
          </div>
          <div className="text-xs text-ink-muted mt-0.5">
            {row.city}{row.age ? ` · גיל ${row.age}` : ''}
          </div>
          <ul className="mt-2 space-y-1">
            {row.blockers.map((b, i) => (
              <li key={i} className="text-xs flex items-start gap-2">
                <Badge tone={SEVERITY_TONE[b.severity]}>{SEVERITY_LABEL[b.severity]}</Badge>
                <span className="text-ink flex-1">{b.message}</span>
                <span className="font-mono text-[10px] text-ink-faint shrink-0">{b.code}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <Link
            to={`/candidates/external/${row.externalCandidateId}`}
            className="text-xs text-brand-700 hover:underline text-center"
          >
            פרופיל
          </Link>
          <Button
            size="sm"
            variant={forceAllowed ? 'secondary' : 'subtle'}
            disabled={!forceAllowed}
            onClick={() => onForce(row)}
            title={forceAllowed
              ? 'אלץ יצירה של הצעה למרות החסימה — ידרוש נימוק ויירשם ביומן'
              : 'חסימה לא ניתנת לעקיפה'}
          >
            {forceAllowed ? 'אלץ עם נימוק' : 'לא ניתן לעקוף'}
          </Button>
        </div>
      </div>
    </li>
  );
});

function ForceMatchDialog({
  internalCandidateId,
  target,
  onClose,
}: {
  internalCandidateId: string;
  target: BlockedMatchItem | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [justification, setJustification] = useState('');
  const [disagree, setDisagree] = useState(false);

  const force = useMutation({
    mutationFn: () => matchesApi.force({
      internalCandidateId,
      externalCandidateId: target!.externalCandidateId,
      mode: 'strict',
      justification: justification.trim(),
    }),
    onSuccess: (r) => {
      toast.success('הצעת שידוך נכפתה', 'נוצרה הצעה עם סימון "נכפתה" ונימוק נרשם ביומן.');
      qc.invalidateQueries({ queryKey: ['internal', internalCandidateId, 'suggestions'] });
      qc.invalidateQueries({ queryKey: ['find-blocked', internalCandidateId] });
      qc.invalidateQueries({ queryKey: ['find-matches', internalCandidateId] });
      setJustification('');
      setDisagree(false);
      onClose();
      // Leave navigation to the operator — they may want to make more before opening the match.
      void r;
    },
    onError: (e) => toast.error('הכפייה נדחתה', (e as Error).message),
  });

  if (!target) return null;

  const name = `${target.firstName ?? ''} ${target.lastName ?? ''}`.trim() || 'מועמד חיצוני';
  const canSubmit = justification.trim().length >= 10 && disagree && !force.isPending;

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={`כפיית התאמה — ${name}`}
      description="פעולה זו יוצרת הצעה למרות חסימות הניתנות לעקיפה. הנימוק יישמר לצמיתות ביומן הביקורת."
      primaryAction={{
        label: 'אלץ יצירה',
        onClick: () => force.mutate(),
        loading: force.isPending,
        disabled: !canSubmit,
      }}
      secondaryAction={{ label: 'ביטול', onClick: onClose }}
    >
      <div className="space-y-3">
        <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
          <div className="text-xs font-semibold text-warning mb-2">חסימות שיעקפו:</div>
          <ul className="space-y-1">
            {target.blockers.map((b, i) => (
              <li key={i} className="text-xs flex items-start gap-2">
                <Badge tone={SEVERITY_TONE[b.severity]}>{SEVERITY_LABEL[b.severity]}</Badge>
                <span className="text-ink flex-1">{b.message}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">
            נימוק (חובה, 10–500 תווים)
          </label>
          <Textarea
            rows={4}
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="למשל: השדכן דיבר עם הצדדים וקיבל עדכון ששינה את הנסיבות."
          />
          <div className="text-[11px] text-ink-faint mt-0.5">
            {justification.trim().length} / 10 נדרש
          </div>
        </div>

        <label className="flex items-start gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={disagree}
            onChange={(e) => setDisagree(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            אני מאשר/ת שהתבוננתי בחסימות וכי האחריות על פעולה זו היא עליי.
            הפעולה תסומן "נכפתה" ותירשם ביומן הביקורת.
          </span>
        </label>
      </div>
    </Dialog>
  );
}
