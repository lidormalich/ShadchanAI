// ═══════════════════════════════════════════════════════════
// ShadchanAI — Failed Candidates (manual entry)
//
// Cards whose automatic extraction failed with a PERMANENT error
// (a deterministic problem — e.g. the AI bled free text into a
// length-capped field — that fails identically on every retry).
// Returning these to the queue never helps, so there is no requeue
// here: the operator enters the candidate BY HAND through the
// normal external-candidate flow. Nothing is imported from the
// card; the original message is shown only for reference and is
// preserved (attached to the candidate as its source on creation).
//
// Transient failures (rate-limit etc.) are NOT here — they stay in
// the review page's "נפלו" tab where a requeue can still succeed.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, RefreshCw, Trash2, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, CardBody, CardHeader, Divider } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { AuthImage } from '@/components/AuthImage';
import { ConfirmActionModal, Dialog } from '@/components/ui/Dialog';
import { ExternalCandidateForm } from '@/features/forms/ExternalCandidateForm';
import { toast } from '@/components/ui/Toast';
import { extractionApi, type FailedQueueItem } from '@/services/api/extraction';
import type { ExternalCandidate } from '@/types/domain';

// Short Hebrew hint about WHAT the operator must fix — the length-cap case
// (a mangled field) is the common one here.
function humanizeFailure(reason?: string): string {
  if (!reason) return 'החילוץ האוטומטי נכשל';
  const r = reason.toLowerCase();
  if (r.includes('longer than the maximum') || r.includes('maxlength')) {
    return 'שדה חרג מהאורך המותר (טקסט חופשי שנכנס לשדה קצר)';
  }
  if (r.includes('validation')) return 'נתון לא תקין בכרטיס';
  return reason.slice(0, 140);
}

export function FailedCandidatesPage() {
  const qc = useQueryClient();
  const failed = useQuery({
    queryKey: ['extraction', 'failed-queue'],
    queryFn: () => extractionApi.failedQueue(200),
  });

  // Only PERMANENT failures need manual entry. Transient ones live in the
  // review page's "נפלו" tab (where a requeue can still help).
  const rows = (failed.data?.data ?? []).filter((f) => f.permanent);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['extraction', 'failed-queue'] });
    qc.invalidateQueries({ queryKey: ['externals'] });
  };

  const reject = useMutation({
    mutationFn: (id: string) => extractionApi.reject(id),
    onSuccess: () => { toast.success('ההודעה סומנה כלא-פרופיל'); invalidate(); },
    onError: (e: Error) => toast.error('הדחייה נכשלה', e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => extractionApi.deleteMessage(id),
    onSuccess: () => { toast.success('ההודעה נמחקה'); invalidate(); },
    onError: (e: Error) => toast.error('המחיקה נכשלה', e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold inline-flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" /> מועמדים שנכשלו
          </h2>
          <p className="text-sm text-ink-muted">
            כרטיסים שהחילוץ האוטומטי לא הצליח לפענח ולא יעזור לנסות שוב. הזן את המועמד ידנית דרך הטופס הרגיל —
            הכרטיס המקורי מוצג לעיון וישמר כמקור של המועמד שתיצור.
          </p>
        </div>
        <Button variant="secondary" onClick={() => failed.refetch()} leftIcon={<RefreshCw className="h-4 w-4" />}>
          רענן
        </Button>
      </div>

      {failed.isError ? (
        <ErrorState description={(failed.error as Error).message} onRetry={() => failed.refetch()} />
      ) : failed.isLoading ? (
        <LoadingSkeleton rows={5} />
      ) : !rows.length ? (
        <EmptyState
          icon={<Check className="h-10 w-10 text-emerald-500" />}
          title="אין מועמדים שנכשלו"
          description="כל הכרטיסים חולצו בהצלחה — אין מה להזין ידנית."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((item) => (
            <FailedCandidateCard
              key={item.messageId}
              item={item}
              onReject={() => reject.mutate(item.messageId)}
              onDelete={() => del.mutate(item.messageId)}
              onResolved={invalidate}
              busy={reject.isPending || del.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FailedCandidateCard({ item, onReject, onDelete, onResolved, busy }: {
  item: FailedQueueItem;
  onReject: () => void;
  onDelete: () => void;
  onResolved: () => void;
  busy: boolean;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // After the operator creates the candidate through the normal flow, attach
  // this card as its source and clear it from the failed queue.
  const link = useMutation({
    mutationFn: (candidate: ExternalCandidate) => extractionApi.linkManual(item.messageId, candidate._id),
    onSuccess: () => {
      toast.success('הכרטיס נשמר כמקור של המועמד שנוצר');
      onResolved();
    },
    // The candidate WAS created; only the card-linking failed. Don't alarm —
    // just tell the operator the card stayed in the list.
    onError: (e: Error) => toast.error('המועמד נוצר, אך קישור הכרטיס נכשל', e.message),
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="danger">נכשל {item.retryCount}× ב-AI</Badge>
            <Badge tone="warning">{humanizeFailure(item.failureReason)}</Badge>
            <span className="text-xs text-ink-muted">{new Date(item.createdAt).toLocaleString('he-IL')}</span>
            <span className="text-xs text-ink-faint">מ־{item.accountDisplayName}</span>
          </div>
          <Link to={`/chats?conversation=${item.conversationId}`} className="text-xs underline text-brand">
            פתח שיחה
          </Link>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {item.failureReason && (
          <details className="text-xs text-ink-muted">
            <summary className="cursor-pointer select-none">פרטי השגיאה הטכנית</summary>
            <div className="mt-1 rounded-md border border-border bg-bg-subtle/40 p-2 font-mono break-all">
              {item.failureReason}
            </div>
          </details>
        )}

        {/* The original card — reference only, nothing is imported from it. */}
        <div>
          <div className="text-xs text-ink-muted mb-1">הכרטיס המקורי (לעיון בלבד)</div>
          <div className="rounded-md border border-border bg-bg-subtle/40 p-2 text-sm whitespace-pre-wrap max-h-72 overflow-y-auto">
            {item.body || '—'}
          </div>
          {item.mediaUrl && <MediaThumb url={item.mediaUrl} />}
        </div>

        <Divider />

        <div className="flex flex-wrap gap-2 justify-end">
          <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy || link.isPending} leftIcon={<Trash2 className="h-4 w-4" />}>
            מחק הודעה
          </Button>
          <Button variant="secondary" onClick={onReject} disabled={busy || link.isPending} leftIcon={<X className="h-4 w-4" />}>
            דחה (לא פרופיל)
          </Button>
          <Button variant="primary" onClick={() => setFormOpen(true)} disabled={busy || link.isPending} leftIcon={<UserPlus className="h-4 w-4" />}>
            הזן מועמד ידנית
          </Button>
        </div>
      </CardBody>

      <ConfirmActionModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="מחיקת הודעה"
        description="ההודעה תימחק לצמיתות ותיעלם מכל התורים. פעולה זו אינה הפיכה."
        variant="danger"
        confirmLabel="מחק"
        loading={busy}
        onConfirm={() => { onDelete(); setConfirmDelete(false); }}
      />

      {/* The FULL normal external-candidate flow — empty, nothing pre-filled. */}
      <ExternalCandidateForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onCreated={(candidate) => link.mutate(candidate)}
      />
    </Card>
  );
}

function MediaThumb({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="mt-2 block" title="הצג תמונה מוגדלת">
        <AuthImage src={url} alt="תמונה מצורפת" className="h-24 w-24 object-cover rounded-md border border-border" />
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="תמונה מצורפת"
        secondaryAction={{ label: 'סגור', onClick: () => setOpen(false) }}
      >
        <AuthImage src={url} alt="תמונה מצורפת" className="max-h-[65vh] w-full object-contain rounded-md" />
      </Dialog>
    </>
  );
}
