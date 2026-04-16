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
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, CardBody, CardHeader, Divider, Input, Select, Textarea } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { extractionApi, type ExtractedProfileInput, type ReviewQueueItem } from '@/services/api/extraction';
import { label } from '@/utils/labels';

export function ReviewQueuePage() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const focusMessageId = searchParams.get('messageId');

  const queue = useQuery({
    queryKey: ['extraction', 'review-queue'],
    queryFn: () => extractionApi.reviewQueue(100),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['extraction', 'review-queue'] });
    qc.invalidateQueries({ queryKey: ['messages'] });
  };

  const approve = useMutation({
    mutationFn: ({ id, profile }: { id: string; profile: ExtractedProfileInput }) =>
      extractionApi.approve(id, profile),
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
              focused={focusMessageId === item.messageId}
              onApprove={(profile) => approve.mutate({ id: item.messageId, profile })}
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

const SECTOR_OPTIONS = ['dati_leumi', 'haredi', 'dati', 'masorti', 'hardal', 'torani', 'other'];
const STATUS_OPTIONS = ['single', 'divorced', 'widowed', 'separated'];

function ReviewCard({
  item, focused, onApprove, onReject, onRerun, busy,
}: {
  item: ReviewQueueItem;
  focused?: boolean;
  onApprove: (profile: ExtractedProfileInput) => void;
  onReject: () => void;
  onRerun: () => void;
  busy: boolean;
}) {
  const [fields, setFields] = useState<ExtractedProfileInput>(item.extractedFields);
  const cardRef = useRef<HTMLDivElement>(null);

  // Re-seed local edits if the underlying extraction record changes
  // (e.g. operator clicked "עבד מחדש" and the pipeline returned fresh fields).
  useEffect(() => { setFields(item.extractedFields); }, [item.extractedFields]);

  // Scroll into view when arrived via dashboard deep link
  // (?messageId=...). Runs once per focus transition.
  useEffect(() => {
    if (focused && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focused]);

  const set = <K extends keyof ExtractedProfileInput>(k: K, v: ExtractedProfileInput[K]) =>
    setFields((prev) => ({ ...prev, [k]: v }));

  const phonesText = fields.contactPhones?.join(', ') ?? '';
  const canApprove = !!(fields.firstName?.trim() || (fields.contactPhones && fields.contactPhones.length > 0));

  return (
    <div ref={cardRef} className={focused ? 'ring-2 ring-brand-400 rounded-lg' : undefined}>
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
          {/* Editable extracted fields */}
          <div>
            <div className="text-xs text-ink-muted mb-1">שדות לאישור (ניתנים לעריכה)</div>
            <div className="rounded-md border border-border bg-white p-3 text-sm grid grid-cols-2 gap-2">
              <EditRow label="שם פרטי"><Input value={fields.firstName ?? ''} onChange={(e) => set('firstName', e.target.value || undefined)} /></EditRow>
              <EditRow label="שם משפחה"><Input value={fields.lastName ?? ''} onChange={(e) => set('lastName', e.target.value || undefined)} /></EditRow>
              <EditRow label="מגדר">
                <Select value={fields.gender ?? ''} onChange={(e) => set('gender', e.target.value || undefined)}>
                  <option value="">—</option>
                  <option value="male">{label('gender', 'male')}</option>
                  <option value="female">{label('gender', 'female')}</option>
                </Select>
              </EditRow>
              <EditRow label="גיל">
                <Input type="number" value={fields.age ?? ''} onChange={(e) => set('age', e.target.value ? Number(e.target.value) : undefined)} />
              </EditRow>
              <EditRow label='גובה (ס"מ)'>
                <Input type="number" value={fields.height ?? ''} onChange={(e) => set('height', e.target.value ? Number(e.target.value) : undefined)} />
              </EditRow>
              <EditRow label="עיר"><Input value={fields.city ?? ''} onChange={(e) => set('city', e.target.value || undefined)} /></EditRow>
              <EditRow label="עדה"><Input value={fields.edah ?? ''} onChange={(e) => set('edah', e.target.value || undefined)} /></EditRow>
              <EditRow label="מגזר">
                <Select value={fields.sectorGroup ?? ''} onChange={(e) => set('sectorGroup', e.target.value || undefined)}>
                  <option value="">—</option>
                  {SECTOR_OPTIONS.map((s) => <option key={s} value={s}>{label('sectorGroup', s)}</option>)}
                </Select>
              </EditRow>
              <EditRow label="סטטוס">
                <Select value={fields.personalStatus ?? ''} onChange={(e) => set('personalStatus', e.target.value || undefined)}>
                  <option value="">—</option>
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{label('personalStatus', s)}</option>)}
                </Select>
              </EditRow>
              <EditRow label="עיסוק"><Input value={fields.occupation ?? ''} onChange={(e) => set('occupation', e.target.value || undefined)} /></EditRow>
              <EditRow label="מגיל">
                <Input type="number" value={fields.seekingAgeMin ?? ''} onChange={(e) => set('seekingAgeMin', e.target.value ? Number(e.target.value) : undefined)} />
              </EditRow>
              <EditRow label="עד גיל">
                <Input type="number" value={fields.seekingAgeMax ?? ''} onChange={(e) => set('seekingAgeMax', e.target.value ? Number(e.target.value) : undefined)} />
              </EditRow>
              <EditRow label="טלפונים (מופרדים בפסיק)" full>
                <Input
                  value={phonesText}
                  onChange={(e) => {
                    const parts = e.target.value.split(',').map((p) => p.trim()).filter(Boolean);
                    set('contactPhones', parts.length ? parts : undefined);
                  }}
                />
              </EditRow>
              <EditRow label="על עצמו" full>
                <Textarea rows={2} value={fields.about ?? ''} onChange={(e) => set('about', e.target.value || undefined)} />
              </EditRow>
              <EditRow label="מה מחפש" full>
                <Textarea rows={2} value={fields.whatSeeking ?? ''} onChange={(e) => set('whatSeeking', e.target.value || undefined)} />
              </EditRow>
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
            onClick={() => onApprove(fields)}
            disabled={busy || !canApprove}
            leftIcon={<Check className="h-4 w-4" />}
            title={canApprove ? undefined : 'חסר שם או טלפון — מלא לפני אישור'}
          >
            אשר וצור
          </Button>
        </div>
      </CardBody>
    </Card>
    </div>
  );
}

function EditRow({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <div className="text-[11px] text-ink-muted mb-0.5">{label}</div>
      {children}
    </div>
  );
}
