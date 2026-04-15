// ═══════════════════════════════════════════════════════════
// ShadchanAI — Extraction Review Queue
//
// Lists every inbound profiles_source message whose automated
// extraction landed in needs_review. For each, the operator sees
// the original message body alongside the fields the pipeline
// extracted, and chooses:
//   - "אשר וצור"     → creates ExternalCandidate from the fields.
//   - "דחה"           → marks the message as not-a-profile (no
//                       candidate). Message won't be re-queued.
//   - "עבד מחדש"      → re-runs the full pipeline (regex + AI)
//                       in case a model/prompt update has been
//                       deployed since the last attempt.
//
// This page is the human safety net for the automated path —
// everything flagged below the auto-create confidence threshold.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Inbox, RefreshCw, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, CardBody, CardHeader, Divider } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { extractionApi, type ReviewQueueItem } from '@/services/api/extraction';
import { label } from '@/utils/labels';

export function ReviewQueuePage() {
  const qc = useQueryClient();
  const queue = useQuery({
    queryKey: ['extraction', 'review-queue'],
    queryFn: () => extractionApi.reviewQueue(100),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['extraction', 'review-queue'] });
    qc.invalidateQueries({ queryKey: ['messages'] });
  };

  const approve = useMutation({
    mutationFn: (id: string) => extractionApi.approve(id),
    onSuccess: (res) => { toast.success('המועמד נוצר בהצלחה', `candidate: ${res.data.candidateId}`); invalidate(); },
    onError: (e: Error) => toast.error('האישור נכשל', e.message),
  });
  const reject = useMutation({
    mutationFn: (id: string) => extractionApi.reject(id),
    onSuccess: () => { toast.success('ההודעה סומנה כלא-פרופיל'); invalidate(); },
    onError: (e: Error) => toast.error('הדחייה נכשלה', e.message),
  });
  const rerun = useMutation({
    mutationFn: (id: string) => extractionApi.run(id),
    onSuccess: (res) => {
      toast.success('החילוץ הורץ מחדש', `סטטוס חדש: ${res.data.status}`);
      invalidate();
    },
    onError: (e: Error) => toast.error('ההרצה נכשלה', e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">תור סקירה</h2>
          <p className="text-sm text-ink-muted">הודעות פרופיל שה-AI לא היה בטוח בהן — אשר, דחה או הרץ מחדש.</p>
        </div>
        <Button variant="secondary" onClick={() => queue.refetch()} leftIcon={<RefreshCw className="h-4 w-4" />}>
          רענן
        </Button>
      </div>

      {queue.isError ? (
        <ErrorState description={(queue.error as Error).message} onRetry={() => queue.refetch()} />
      ) : queue.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : !queue.data?.data.length ? (
        <EmptyState
          icon={<Inbox className="h-10 w-10 text-ink-faint" />}
          title="התור ריק"
          description="אין פרופילים שמחכים לסקירה כרגע."
        />
      ) : (
        <div className="space-y-3">
          {queue.data.data.map((item) => (
            <ReviewCard
              key={item.messageId}
              item={item}
              onApprove={() => approve.mutate(item.messageId)}
              onReject={() => reject.mutate(item.messageId)}
              onRerun={() => rerun.mutate(item.messageId)}
              busy={approve.isPending || reject.isPending || rerun.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewCard({
  item, onApprove, onReject, onRerun, busy,
}: {
  item: ReviewQueueItem;
  onApprove: () => void;
  onReject: () => void;
  onRerun: () => void;
  busy: boolean;
}) {
  const f = item.extractedFields;
  const canApprove = !!(f.firstName || (f.contactPhones && f.contactPhones.length > 0));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="warning">ממתין לסקירה</Badge>
            <span className="text-xs text-ink-muted">
              {new Date(item.createdAt).toLocaleString('he-IL')}
            </span>
            <span className="text-xs text-ink-faint">
              מ־{item.accountDisplayName}
            </span>
            {item.extraction?.method && (
              <Badge tone="neutral">{item.extraction.method}</Badge>
            )}
            <span className="text-xs text-ink-muted">
              confidence: {(item.regexConfidence * 100).toFixed(0)}%
            </span>
          </div>
          <Link to={`/chats?conversation=${item.conversationId}`} className="text-xs underline text-brand">
            פתח שיחה
          </Link>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Original body */}
          <div>
            <div className="text-xs text-ink-muted mb-1">ההודעה המקורית</div>
            <div className="rounded-md border border-border bg-bg-subtle/40 p-2 text-sm whitespace-pre-wrap max-h-72 overflow-y-auto">
              {item.body}
            </div>
          </div>
          {/* Extracted fields */}
          <div>
            <div className="text-xs text-ink-muted mb-1">שדות שחולצו</div>
            <div className="rounded-md border border-border bg-white p-2 text-sm">
              <FieldRow k="שם" v={[f.firstName, f.lastName].filter(Boolean).join(' ') || undefined} />
              <FieldRow k="מגדר" v={f.gender ? label('gender', f.gender) : undefined} />
              <FieldRow k="גיל" v={f.age} />
              <FieldRow k="גובה" v={f.height ? `${f.height} ס"מ` : undefined} />
              <FieldRow k="עיר" v={f.city} />
              <FieldRow k="עדה" v={f.edah} />
              <FieldRow k="מגזר" v={f.sectorGroup ? label('sectorGroup', f.sectorGroup) : undefined} />
              <FieldRow k="סטטוס" v={f.personalStatus ? label('personalStatus', f.personalStatus) : undefined} />
              <FieldRow k="עיסוק" v={f.occupation} />
              <FieldRow k="טווח גילים" v={(f.seekingAgeMin || f.seekingAgeMax) ? `${f.seekingAgeMin ?? '?'}–${f.seekingAgeMax ?? '?'}` : undefined} />
              <FieldRow k="טלפונים" v={f.contactPhones?.join(', ')} />
            </div>
          </div>
        </div>

        <Divider />

        <div className="flex flex-wrap gap-2 justify-end">
          <Button variant="secondary" onClick={onRerun} disabled={busy} leftIcon={<RefreshCw className="h-4 w-4" />}>
            עבד מחדש
          </Button>
          <Button variant="secondary" onClick={onReject} disabled={busy} leftIcon={<X className="h-4 w-4" />}>
            דחה (לא פרופיל)
          </Button>
          <Button
            variant="primary"
            onClick={onApprove}
            disabled={busy || !canApprove}
            leftIcon={<Check className="h-4 w-4" />}
            title={canApprove ? undefined : 'חסר שם או טלפון — דחה או ערוך קודם'}
          >
            אשר וצור
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function FieldRow({ k, v }: { k: string; v?: string | number }) {
  if (v === undefined || v === null || v === '') return null;
  return (
    <div className="flex items-center justify-between text-xs border-b border-border/60 py-1 last:border-0">
      <span className="text-ink-muted">{k}</span>
      <span className="text-end">{v}</span>
    </div>
  );
}
