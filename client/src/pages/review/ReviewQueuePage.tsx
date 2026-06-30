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
import { Check, Filter, Inbox, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, CardBody, CardHeader, Divider, Input, Select, Textarea } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import {
  extractionApi,
  type ExtractedProfileInput,
  type IngestionDecision,
  type IngestionLogItem,
  type ReviewQueueItem,
} from '@/services/api/extraction';
import { label } from '@/utils/labels';

// Hebrew labels + tone for each ingestion routing verdict.
const INGESTION_LABEL: Record<IngestionDecision, { text: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  accepted: { text: 'נקלטה לחילוץ', tone: 'success' },
  ignored_assigned_ignore: { text: 'סוננה — צ׳אט מסומן "התעלם"', tone: 'neutral' },
  ignored_match_sending: { text: 'סוננה — צ׳אט שליחה', tone: 'neutral' },
  ignored_unmapped: { text: 'סוננה — צ׳אט לא ממופה', tone: 'warning' },
};

export function ReviewQueuePage() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const focusMessageId = searchParams.get('messageId');
  const [tab, setTab] = useState<'review' | 'filtered'>('review');

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
          <h2 className="text-lg font-semibold">{tab === 'review' ? 'תור סקירה' : 'הודעות שסוננו'}</h2>
          <p className="text-sm text-ink-muted">
            {tab === 'review'
              ? 'הודעות פרופיל שה-AI לא היה בטוח בהן — אשר, דחה או הרץ מחדש.'
              : 'הודעות שהגיעו אך לא נכנסו לחילוץ — וסיבת הסינון. אפשר לאלץ עיבוד מחדש.'}
          </p>
        </div>
        {tab === 'review' && (
          <Button variant="secondary" onClick={() => queue.refetch()} leftIcon={<RefreshCw className="h-4 w-4" />}>
            רענן
          </Button>
        )}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 border-b border-border">
        <TabButton active={tab === 'review'} onClick={() => setTab('review')} icon={<Inbox className="h-4 w-4" />}>
          תור סקירה
        </TabButton>
        <TabButton active={tab === 'filtered'} onClick={() => setTab('filtered')} icon={<Filter className="h-4 w-4" />}>
          הודעות שסוננו
        </TabButton>
      </div>

      {tab === 'filtered' ? (
        <FilteredMessagesSection />
      ) : queue.isError ? (
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

function TabButton({ active, onClick, icon, children }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
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
    </button>
  );
}

// ── Filtered (ignored) messages: the ingestion blind-spot view ──
// Lists inbound messages that arrived but did NOT feed the extraction
// pipeline, with the reason. Operators can force a reprocess (e.g. after
// mapping the chat) via the same /run endpoint the review queue uses.
function FilteredMessagesSection() {
  const qc = useQueryClient();
  const [decision, setDecision] = useState<IngestionDecision | 'ignored' | 'all'>('ignored');

  const log = useQuery({
    queryKey: ['extraction', 'ingestion-log', decision],
    queryFn: () => extractionApi.ingestionLog(decision, 100),
  });

  const reprocess = useMutation({
    mutationFn: (id: string) => extractionApi.run(id),
    onSuccess: (res) => {
      toast.success('עובד מחדש', `סטטוס חילוץ: ${res.data.status}`);
      qc.invalidateQueries({ queryKey: ['extraction', 'ingestion-log'] });
      qc.invalidateQueries({ queryKey: ['extraction', 'review-queue'] });
    },
    onError: (e: Error) => toast.error('העיבוד נכשל', e.message),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Select
          value={decision}
          onChange={(e) => setDecision(e.target.value as IngestionDecision | 'ignored' | 'all')}
          className="max-w-xs"
        >
          <option value="ignored">כל ההודעות שסוננו</option>
          <option value="ignored_unmapped">צ׳אט לא ממופה</option>
          <option value="ignored_assigned_ignore">צ׳אט מסומן "התעלם"</option>
          <option value="ignored_match_sending">צ׳אט שליחה</option>
          <option value="all">הכול (כולל שנקלטו)</option>
        </Select>
        <Button variant="secondary" onClick={() => log.refetch()} leftIcon={<RefreshCw className="h-4 w-4" />}>
          רענן
        </Button>
      </div>

      {log.isError ? (
        <ErrorState description={(log.error as Error).message} onRetry={() => log.refetch()} />
      ) : log.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : !log.data?.data.length ? (
        <EmptyState
          icon={<Filter className="h-10 w-10 text-ink-faint" />}
          title="אין הודעות שסוננו"
          description="כל ההודעות שהגיעו נקלטו, או שעדיין אין נתוני סינון."
        />
      ) : (
        <div className="space-y-2">
          {log.data.data.map((item) => (
            <FilteredCard
              key={item.messageId}
              item={item}
              onReprocess={() => reprocess.mutate(item.messageId)}
              busy={reprocess.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilteredCard({ item, onReprocess, busy }: {
  item: IngestionLogItem;
  onReprocess: () => void;
  busy: boolean;
}) {
  const verdict = item.ingestion ? INGESTION_LABEL[item.ingestion.decision] : undefined;
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            {verdict && <Badge tone={verdict.tone}>{verdict.text}</Badge>}
            {item.extractionStatus && <Badge tone="neutral">חילוץ: {item.extractionStatus}</Badge>}
            <span className="text-xs text-ink-muted">{new Date(item.createdAt).toLocaleString('he-IL')}</span>
            <span className="text-xs text-ink-faint">מ־{item.accountDisplayName}</span>
          </div>
          <div className="flex items-center gap-2">
            <Link to={`/chats?conversation=${item.conversationId}`} className="text-xs underline text-brand">
              פתח שיחה
            </Link>
            <Button variant="secondary" onClick={onReprocess} disabled={busy} leftIcon={<RefreshCw className="h-4 w-4" />}>
              אלץ עיבוד
            </Button>
          </div>
        </div>
        {item.body && (
          <div className="rounded-md border border-border bg-bg-subtle/40 p-2 text-sm whitespace-pre-wrap max-h-40 overflow-y-auto">
            {item.body}
          </div>
        )}
      </CardBody>
    </Card>
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
            <div className="rounded-md border border-border bg-white p-3 text-sm grid grid-cols-1 sm:grid-cols-2 gap-2">
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
