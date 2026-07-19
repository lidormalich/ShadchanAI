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
import { AlertTriangle, Ban, Check, Copy, Eye, Filter, GraduationCap, Inbox, Link2, RefreshCw, RotateCcw, Sparkles, Trash2, UserPlus, Users, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, CardBody, CardHeader, Divider, Input, Select, Textarea } from '@/components/ui/primitives';
import { ConfirmActionModal, Dialog } from '@/components/ui/Dialog';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { AuthImage } from '@/components/AuthImage';
import { ExternalCandidateDrawer } from '@/pages/candidates/ExternalCandidateDrawer';
import { toast } from '@/components/ui/Toast';
import {
  extractionApi,
  type CardLabelField,
  type ExtractedProfileInput,
  type FailedQueueItem,
  type IngestionDecision,
  type IngestionLogItem,
  type ReviewQueueItem,
  type ReviewReason,
} from '@/services/api/extraction';
import { label } from '@/utils/labels';

// Field a raw card label can be taught to map to (Feature C). Hebrew names
// mirror the profile fields the parser fills.
const CARD_FIELD_OPTIONS: { value: CardLabelField; label: string }[] = [
  { value: 'name', label: 'שם' },
  { value: 'age', label: 'גיל' },
  { value: 'height', label: 'גובה' },
  { value: 'city', label: 'עיר / מגורים' },
  { value: 'edah', label: 'עדה' },
  { value: 'sector', label: 'רמה דתית / מגזר' },
  { value: 'status', label: 'מצב משפחתי' },
  { value: 'occupation', label: 'עיסוק' },
  { value: 'about', label: 'על עצמו' },
  { value: 'family', label: 'משפחה' },
  { value: 'service', label: 'שירות צבאי/לאומי' },
  { value: 'yeshiva', label: 'ישיבה / השכלה' },
  { value: 'seeking', label: 'מה מחפש' },
  { value: 'ageRange', label: 'טווח גילאים' },
  { value: 'maxAge', label: 'עד גיל' },
  { value: 'phone', label: 'טלפון' },
  { value: 'other', label: 'אחר — מידע כללי (לא משפיע על ניקוד)' },
  { value: 'ignore', label: 'התעלם משדה זה' },
];

// Hebrew labels for the pipeline's review reason — why a message
// landed in the queue instead of auto-creating a candidate.
const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  suspected_duplicate: 'חשד לכפול',
  low_confidence: 'ביטחון נמוך',
  no_identifier: 'חסר שם/טלפון',
  no_corroboration: 'ללא אימות מבני',
  vision_image: 'חולץ מתמונה',
};

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
  const [tab, setTab] = useState<'review' | 'duplicates' | 'failed' | 'filtered'>('review');
  const [learnOpen, setLearnOpen] = useState(false);

  const queue = useQuery({
    queryKey: ['extraction', 'review-queue'],
    queryFn: () => extractionApi.reviewQueue(100),
  });
  // Page-level failed query drives the tab badge count; the section below
  // shares the same queryKey so React Query serves both from one fetch.
  const failed = useQuery({
    queryKey: ['extraction', 'failed-queue'],
    queryFn: () => extractionApi.failedQueue(100),
  });

  const rows = queue.data?.data ?? [];
  const pendingRows = rows.filter((r) => !r.suspectedCandidate);
  const duplicateRows = rows.filter((r) => r.suspectedCandidate);
  // Only transient (retryable) failures belong in this tab; PERMANENT ones
  // need manual entry and live on the "מועמדים שנכשלו" page.
  const failedCount = (failed.data?.data ?? []).filter((f) => !f.permanent).length;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['extraction', 'review-queue'] });
    qc.invalidateQueries({ queryKey: ['messages'] });
  };

  const approve = useMutation({
    mutationFn: ({ id, profile, linkToCandidateId }: { id: string; profile?: ExtractedProfileInput; linkToCandidateId?: string }) =>
      extractionApi.approve(id, { profile, linkToCandidateId }),
    onSuccess: (res) => {
      if (res.data.linked) {
        toast.success('ההודעה קושרה למועמד הקיים', `candidate: ${res.data.candidateId}`);
      } else {
        toast.success('המועמד נוצר בהצלחה', `candidate: ${res.data.candidateId}`);
      }
      invalidate();
    },
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
  // Merge same-person cards sitting in the queue: create ONE candidate from the
  // primary card, then link every duplicate's message to it. Reuses the same
  // approve endpoint (create once, then approve-with-linkToCandidateId).
  const mergeDuplicates = useMutation({
    mutationFn: async ({ primaryId, profile, dupIds }: { primaryId: string; profile: ExtractedProfileInput; dupIds: string[] }) => {
      const res = await extractionApi.approve(primaryId, { profile });
      const candidateId = res.data.candidateId;
      for (const id of dupIds) {
        await extractionApi.approve(id, { linkToCandidateId: candidateId });
      }
      return { candidateId, linked: dupIds.length };
    },
    onSuccess: (r) => {
      toast.success('הכפולים מוזגו', `נוצר מועמד אחד וקושרו אליו ${r.linked} כרטיסים`);
      invalidate();
    },
    onError: (e: Error) => toast.error('המיזוג נכשל', e.message),
  });
  const refreshAll = useMutation({
    mutationFn: () => extractionApi.refreshAll(),
    onSuccess: (res) => {
      const { photosAttached, photosScanned, semanticStarted } = res.data;
      toast.success(
        'רענון כללי הושלם',
        `תמונות: ${photosAttached}/${photosScanned} צורפו${semanticStarted ? ' · עיבוד סמנטי רץ ברקע' : ''}`,
      );
      invalidate();
    },
    onError: (e: Error) => toast.error('הרענון נכשל', e.message),
  });
  // Re-run extraction on all pending cards — after teaching new labels, cards
  // whose format is now understood auto-resolve and leave the queue.
  const reprocessPending = useMutation({
    mutationFn: () => extractionApi.reprocessNeedsReview(),
    onSuccess: (res) => {
      toast.success('הממתינים נשלחו לעיבוד מחדש', `${res.data.requeued} כרטיסים — התור יתעדכן בהדרגה`);
      setTimeout(invalidate, 2500);
    },
    onError: (e: Error) => toast.error('העיבוד מחדש נכשל', e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {tab === 'review' ? 'תור סקירה'
              : tab === 'duplicates' ? 'כפולים אפשריים'
              : tab === 'failed' ? 'נפלו בחילוץ'
              : 'הודעות שסוננו'}
          </h2>
          <p className="text-sm text-ink-muted">
            {tab === 'review'
              ? 'הודעות פרופיל שה-AI לא היה בטוח בהן — אשר, דחה או הרץ מחדש.'
              : tab === 'duplicates'
                ? 'פרופילים חדשים שדומים למועמד קיים — קשר לקיים או צור חדש.'
                : tab === 'failed'
                  ? 'פרופילים שהחילוץ שלהם נכשל (בדרך כלל מגבלת קצב AI) — החזר אותם לתור לעיבוד מחדש.'
                  : 'הודעות שהגיעו אך לא נכנסו לחילוץ — וסיבת הסינון. אפשר לאלץ עיבוד מחדש.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setLearnOpen(true)}
            leftIcon={<GraduationCap className="h-4 w-4" />}
            title="הדבק כרטיס שידוך שלם — המערכת תלמד את התוויות שלו וכל כרטיס עתידי בפורמט הזה יפוענח לבד"
          >
            למד פורמט חדש
          </Button>
          <Button
            variant="secondary"
            onClick={() => reprocessPending.mutate()}
            disabled={reprocessPending.isPending}
            leftIcon={<RotateCcw className="h-4 w-4" />}
            title="מריץ מחדש חילוץ על כל הכרטיסים הממתינים — אחרי שלימדת תוויות/פורמטים, מה שהמערכת כבר מבינה יֵצא מהתור לבד"
          >
            {reprocessPending.isPending ? 'שולח…' : 'עבד מחדש ממתינים'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => refreshAll.mutate()}
            disabled={refreshAll.isPending}
            leftIcon={<Sparkles className="h-4 w-4" />}
            title="מצרף תמונות למועמדים קיימים שחסרות להם + מריץ עיבוד סמנטי"
          >
            {refreshAll.isPending ? 'מרענן…' : 'רענן כללי'}
          </Button>
          {(tab === 'review' || tab === 'duplicates') && (
            <Button variant="secondary" onClick={() => queue.refetch()} leftIcon={<RefreshCw className="h-4 w-4" />}>
              רענן
            </Button>
          )}
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 border-b border-border">
        <TabButton
          active={tab === 'review'}
          onClick={() => setTab('review')}
          icon={<Inbox className="h-4 w-4" />}
          count={pendingRows.length}
        >
          ממתינים לבדיקה
        </TabButton>
        <TabButton
          active={tab === 'duplicates'}
          onClick={() => setTab('duplicates')}
          icon={<Copy className="h-4 w-4" />}
          count={duplicateRows.length}
        >
          כפולים אפשריים
        </TabButton>
        <TabButton
          active={tab === 'failed'}
          onClick={() => setTab('failed')}
          icon={<AlertTriangle className="h-4 w-4" />}
          count={failedCount}
        >
          נפלו
        </TabButton>
        <TabButton active={tab === 'filtered'} onClick={() => setTab('filtered')} icon={<Filter className="h-4 w-4" />}>
          הודעות שסוננו
        </TabButton>
      </div>

      {tab === 'failed' ? (
        <FailedMessagesSection />
      ) : tab === 'filtered' ? (
        <FilteredMessagesSection />
      ) : queue.isError ? (
        <ErrorState description={(queue.error as Error).message} onRetry={() => queue.refetch()} />
      ) : queue.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : tab === 'duplicates' ? (
        !duplicateRows.length ? (
          <EmptyState
            icon={<Copy className="h-10 w-10 text-ink-faint" />}
            title="אין כפולים אפשריים"
            description="אף פרופיל חדש לא נחשד ככפול של מועמד קיים."
          />
        ) : (
          <div className="space-y-3">
            {duplicateRows.map((item) => (
              <DuplicateCard
                key={item.messageId}
                item={item}
                focused={focusMessageId === item.messageId}
                onLinkExisting={() => approve.mutate({ id: item.messageId, linkToCandidateId: item.suspectedCandidate!.id })}
                onCreateNew={() => approve.mutate({ id: item.messageId, profile: item.extractedFields })}
                onReject={() => reject.mutate(item.messageId)}
                busy={approve.isPending || reject.isPending}
              />
            ))}
          </div>
        )
      ) : !pendingRows.length ? (
        <EmptyState
          icon={<Inbox className="h-10 w-10 text-ink-faint" />}
          title="התור ריק"
          description="אין פרופילים שמחכים לסקירה כרגע."
        />
      ) : (
        <div className="space-y-3">
          {pendingRows.map((item) => (
            <ReviewCard
              key={item.messageId}
              item={item}
              focused={focusMessageId === item.messageId}
              findQueueItem={(mid) => rows.find((r) => r.messageId === mid)}
              onApprove={(profile) => approve.mutate({ id: item.messageId, profile })}
              onReject={() => reject.mutate(item.messageId)}
              onRerun={() => rerun.mutate(item.messageId)}
              onMergeDuplicates={(profile) => mergeDuplicates.mutate({
                primaryId: item.messageId,
                profile,
                dupIds: (item.pendingDuplicates ?? []).map((d) => d.messageId),
              })}
              busy={approve.isPending || reject.isPending || rerun.isPending || mergeDuplicates.isPending}
            />
          ))}
        </div>
      )}

      <LearnFormatDialog open={learnOpen} onClose={() => setLearnOpen(false)} onLearned={invalidate} />
    </div>
  );
}

// ── "Learn a new format" dialog (Feature C+) ─────────────
// Paste a full card → the parser reports recognized fields + unknown labels,
// the AI proposes a field per unknown label, the operator confirms, and the
// whole format is taught at once. Every future card in that format then parses.
function LearnFormatDialog({ open, onClose, onLearned }: {
  open: boolean;
  onClose: () => void;
  onLearned: () => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [picks, setPicks] = useState<Record<string, CardLabelField | ''>>({});

  const analyze = useMutation({
    mutationFn: () => extractionApi.analyzeCard(text),
    onSuccess: (res) => {
      // Pre-fill each unknown label with the AI's suggestion.
      const seed: Record<string, CardLabelField | ''> = {};
      for (const u of res.data.unknownLabels) seed[u.label] = u.suggestedField ?? '';
      setPicks(seed);
    },
    onError: (e: Error) => toast.error('הניתוח נכשל', e.message),
  });

  const save = useMutation({
    mutationFn: () => {
      const mappings = Object.entries(picks)
        .filter(([, f]) => !!f)
        .map(([label, field]) => ({ label, field: field as CardLabelField }));
      return extractionApi.addCardLabelsBulk(mappings);
    },
    onSuccess: (res) => {
      toast.success('הפורמט נלמד', `${res.data.created} תוויות נוספו${res.data.skipped ? ` · ${res.data.skipped} כבר קיימות` : ''}`);
      qc.invalidateQueries({ queryKey: ['card-labels'] });
      onLearned();
      reset();
      onClose();
    },
    onError: (e: Error) => toast.error('השמירה נכשלה', e.message),
  });

  const reset = () => { setText(''); setPicks({}); analyze.reset(); };
  const result = analyze.data?.data;
  const chosenCount = Object.values(picks).filter(Boolean).length;

  return (
    <Dialog
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="למד פורמט כרטיס חדש"
      secondaryAction={{ label: 'סגור', onClick: () => { reset(); onClose(); } }}
      primaryAction={result && result.unknownLabels.length > 0
        ? { label: `שמור ${chosenCount} תוויות`, onClick: () => save.mutate(), loading: save.isPending, disabled: chosenCount === 0 }
        : undefined}
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-muted">
          הדבק כרטיס שידוך שלם. המערכת תראה מה היא כבר מזהה ומה לא — וה-AI יציע לאיזה שדה למפות כל תווית לא-מזוהה.
          אחרי שמירה, כל כרטיס עתידי בפורמט הזה יפוענח אוטומטית.
        </p>
        <Textarea
          rows={6}
          dir="rtl"
          placeholder={'הדבק כאן כרטיס שידוך שלם…\nלמשל: שם: … גיל: … כינוי: …'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex justify-end">
          <Button
            variant="secondary"
            onClick={() => analyze.mutate()}
            disabled={!text.trim() || analyze.isPending}
            leftIcon={<Sparkles className="h-4 w-4" />}
          >
            {analyze.isPending ? 'מנתח…' : 'נתח'}
          </Button>
        </div>

        {result && (
          <div className="space-y-3 border-t border-border pt-3">
            {result.recognizedFields.length > 0 && (
              <div>
                <div className="text-xs font-medium text-ink-muted mb-1">כבר מזוהה ({result.recognizedFields.length})</div>
                <div className="flex flex-wrap gap-1.5">
                  {result.recognizedFields.map((f) => (
                    <Badge key={f} tone="success">
                      {CARD_FIELD_OPTIONS.find((o) => o.value === f)?.label ?? f}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {result.unknownLabels.length === 0 ? (
              <div className="text-sm text-success">כל התוויות בכרטיס כבר מוכרות — אין מה ללמד 🎉</div>
            ) : (
              <div>
                <div className="text-xs font-medium text-ink-muted mb-1">תוויות לא-מזוהות — מפה כל אחת (הצעת AI מסומנת)</div>
                <div className="space-y-1.5">
                  {result.unknownLabels.map((u) => (
                    <div key={u.label} className="flex items-center gap-2 flex-wrap text-sm">
                      <span className="font-medium text-ink">{u.label}</span>
                      {u.value && <span className="text-xs text-ink-faint truncate max-w-[12rem]">= {u.value}</span>}
                      <span className="text-ink-faint text-xs">→</span>
                      <Select
                        className="w-44"
                        value={picks[u.label] ?? ''}
                        onChange={(e) => setPicks((p) => ({ ...p, [u.label]: e.target.value as CardLabelField | '' }))}
                      >
                        <option value="">אל תמפה</option>
                        {CARD_FIELD_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </Select>
                      {u.suggestedField && picks[u.label] === u.suggestedField && (
                        <span className="text-[11px] text-brand-600">הצעת AI</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
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

// ── Failed extractions: casualties (usually AI rate-limit) ──
// Every message whose extraction ended in FAILED, with how many times it fell
// and why. Operators can push one — or all — back into the throttled queue.
function humanizeFailure(reason?: string): { text: string; rateLimit: boolean } {
  if (!reason) return { text: 'סיבה לא ידועה', rateLimit: false };
  const r = reason.toLowerCase();
  if (r.includes('429') || r.includes('rate limit') || r.includes('rate_limit')) {
    return { text: 'מגבלת קצב AI (rate limit)', rateLimit: true };
  }
  if (r.includes('timeout') || r.includes('abort')) return { text: 'פסק זמן (timeout)', rateLimit: false };
  if (r.includes('vision')) return { text: 'כשל חילוץ מתמונה', rateLimit: false };
  return { text: reason.slice(0, 120), rateLimit: false };
}

function FailedMessagesSection() {
  const qc = useQueryClient();
  const failed = useQuery({
    queryKey: ['extraction', 'failed-queue'],
    queryFn: () => extractionApi.failedQueue(100),
  });
  const all = failed.data?.data ?? [];
  // Requeuable failures only (transient — usually rate-limit). PERMANENT ones
  // moved to the dedicated manual-entry page.
  const rows = all.filter((f) => !f.permanent);
  const permanentCount = all.length - rows.length;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['extraction', 'failed-queue'] });
    qc.invalidateQueries({ queryKey: ['extraction', 'review-queue'] });
  };

  const requeue = useMutation({
    mutationFn: (id: string) => extractionApi.requeue(id),
    onSuccess: () => { toast.success('הוחזר לתור', 'יעובד מחדש בקצב מבוקר'); invalidate(); },
    onError: (e: Error) => toast.error('ההחזרה לתור נכשלה', e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => extractionApi.deleteMessage(id),
    onSuccess: () => { toast.success('ההודעה נמחקה'); invalidate(); },
    onError: (e: Error) => toast.error('המחיקה נכשלה', e.message),
  });
  const requeueAll = useMutation({
    mutationFn: () => extractionApi.requeueAllFailed(),
    onSuccess: (res) => { toast.success('כל הנפולים הוחזרו לתור', `${res.data.requeued} הודעות`); invalidate(); },
    onError: (e: Error) => toast.error('ההחזרה לתור נכשלה', e.message),
  });

  return (
    <div className="space-y-3">
      {permanentCount > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {permanentCount} כרטיסים נכשלו לצמיתות ומחכים להזנה ידנית ב־
          <Link to="/candidates/failed" className="underline font-medium">מועמדים שנכשלו</Link>.
        </div>
      )}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-ink-muted">
          {rows.length > 0
            ? `${rows.length} הודעות נפלו בחילוץ (זמני — בד"כ מגבלת קצב). החזר לתור — הן יעובדו מחדש בקצב מבוקר.`
            : ''}
        </p>
        <div className="flex items-center gap-2">
          {rows.length > 0 && (
            <Button
              variant="primary"
              onClick={() => requeueAll.mutate()}
              disabled={requeueAll.isPending}
              leftIcon={<RotateCcw className="h-4 w-4" />}
            >
              {requeueAll.isPending ? 'מחזיר…' : 'החזר הכל לתור'}
            </Button>
          )}
          <Button variant="secondary" onClick={() => failed.refetch()} leftIcon={<RefreshCw className="h-4 w-4" />}>
            רענן
          </Button>
        </div>
      </div>

      {failed.isError ? (
        <ErrorState description={(failed.error as Error).message} onRetry={() => failed.refetch()} />
      ) : failed.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : !rows.length ? (
        <EmptyState
          icon={<AlertTriangle className="h-10 w-10 text-ink-faint" />}
          title="אין נפולים"
          description="כל החילוצים הסתיימו בהצלחה — אין הודעות שנפלו."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((item) => (
            <FailedCard
              key={item.messageId}
              item={item}
              onRequeue={() => requeue.mutate(item.messageId)}
              onDelete={() => del.mutate(item.messageId)}
              busy={requeue.isPending || requeueAll.isPending || del.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FailedCard({ item, onRequeue, onDelete, busy }: {
  item: FailedQueueItem;
  onRequeue: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reason = humanizeFailure(item.failureReason);
  const when = item.completedAt ?? item.createdAt;
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="danger">נפל {item.retryCount > 0 ? `${item.retryCount} פעמים` : ''}</Badge>
            <Badge tone={reason.rateLimit ? 'warning' : 'neutral'}>{reason.text}</Badge>
            <span className="text-xs text-ink-muted">{new Date(when).toLocaleString('he-IL')}</span>
            <span className="text-xs text-ink-faint">מ־{item.accountDisplayName}</span>
          </div>
          <div className="flex items-center gap-2">
            <Link to={`/chats?conversation=${item.conversationId}`} className="text-xs underline text-brand">
              פתח שיחה
            </Link>
            <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy} leftIcon={<Trash2 className="h-4 w-4" />}>
              מחק
            </Button>
            <Button variant="primary" onClick={onRequeue} disabled={busy} leftIcon={<RotateCcw className="h-4 w-4" />}>
              החזר לתור
            </Button>
          </div>
        </div>
        {item.body && (
          <div className="rounded-md border border-border bg-bg-subtle/40 p-2 text-sm whitespace-pre-wrap max-h-40 overflow-y-auto">
            {item.body}
          </div>
        )}
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
    </Card>
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

// ── Label-learning panel (Feature C) ─────────────────────
// Shows the labeled lines the deterministic parser did NOT recognize. The
// operator maps a line's label to a canonical field once; the parser learns it
// (card-label dictionary) so every future card in that format auto-parses and
// never reaches this queue. After teaching, we re-run this message so the
// operator sees it re-parse immediately.
function LearnLabelsPanel({ item, onTaught }: { item: ReviewQueueItem; onTaught: () => void }) {
  // Only lines shaped like "label: value" are teachable labels.
  const labelLines = (item.unmatchedLines ?? [])
    .map((l) => {
      const m = l.match(/^\s*([^:：?？]{1,40})[:：?？]\s*(.*)$/);
      return m ? { raw: l, label: m[1]!.trim(), value: (m[2] ?? '').trim() } : null;
    })
    .filter((x): x is { raw: string; label: string; value: string } => !!x && x.label.length > 0);

  const [picks, setPicks] = useState<Record<string, CardLabelField | ''>>({});

  const learn = useMutation({
    mutationFn: ({ label: lbl, field }: { label: string; field: CardLabelField }) => extractionApi.addCardLabel(lbl, field),
    onSuccess: () => { toast.success('התווית נלמדה', 'מריץ עיבוד מחדש להחלה'); onTaught(); },
    onError: (e: Error) => toast.error('לימוד התווית נכשל', e.message),
  });

  if (labelLines.length === 0) return null;

  return (
    <div className="rounded-md border border-dashed border-amber-300 bg-amber-50/40 p-3 space-y-2">
      <div className="text-xs font-medium text-amber-800">
        תוויות שהפענוח לא זיהה — למד אותן וכל כרטיס עתידי בפורמט הזה יפוענח לבד
      </div>
      <div className="space-y-1.5">
        {labelLines.map((ll) => (
          <div key={ll.raw} className="flex items-center gap-2 flex-wrap text-sm">
            <span className="font-medium text-ink">{ll.label}</span>
            {ll.value && <span className="text-xs text-ink-faint truncate max-w-[14rem]">= {ll.value}</span>}
            <span className="text-ink-faint text-xs">→</span>
            <Select
              className="w-40"
              value={picks[ll.label] ?? ''}
              onChange={(e) => setPicks((p) => ({ ...p, [ll.label]: e.target.value as CardLabelField | '' }))}
            >
              <option value="">בחר שדה…</option>
              {CARD_FIELD_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </Select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!picks[ll.label] || learn.isPending}
              onClick={() => picks[ll.label] && learn.mutate({ label: ll.label, field: picks[ll.label] as CardLabelField })}
            >
              למד
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewCard({
  item, focused, findQueueItem, onApprove, onReject, onRerun, onMergeDuplicates, busy,
}: {
  item: ReviewQueueItem;
  focused?: boolean;
  /** Resolves another queue item by messageId so a suspected duplicate can be
   *  opened in full for a side-by-side comparison before merging. */
  findQueueItem?: (messageId: string) => ReviewQueueItem | undefined;
  onApprove: (profile: ExtractedProfileInput) => void;
  onReject: () => void;
  onRerun: () => void;
  onMergeDuplicates: (profile: ExtractedProfileInput) => void;
  busy: boolean;
}) {
  const [fields, setFields] = useState<ExtractedProfileInput>(item.extractedFields);
  const [previewId, setPreviewId] = useState<string | null>(null);
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
            {!!item.pendingDuplicates?.length && (
              <Badge tone="danger">כפול בתור ({item.pendingDuplicates.length})</Badge>
            )}
            <SourceGroupControl item={item} />
            <span className="text-xs text-ink-muted">
              {new Date(item.createdAt).toLocaleString('he-IL')}
            </span>
            <span className="text-xs text-ink-faint">
              מ־{item.accountDisplayName}
            </span>
            {item.extraction?.method && (
              <Badge tone="neutral">{item.extraction.method}</Badge>
            )}
            {item.reviewReason && (
              <Badge tone="info">{REVIEW_REASON_LABEL[item.reviewReason] ?? item.reviewReason}</Badge>
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
        {!!item.pendingDuplicates?.length && (
          <div className="rounded-md border border-red-200 bg-red-50/50 p-3 space-y-2">
            <div className="text-xs font-medium text-red-800">
              נראה שאותו אדם מופיע {item.pendingDuplicates.length + 1} פעמים בתור (לפי שם/גיל/טלפון/עיר):
            </div>
            <ul className="text-xs text-ink space-y-1">
              {item.pendingDuplicates.map((d) => (
                <li key={d.messageId} className="flex items-center justify-between gap-2">
                  <span>
                    · {`${d.firstName ?? ''} ${d.lastName ?? ''}`.trim() || 'ללא שם'}
                    {[d.age ? `גיל ${d.age}` : '', d.city, d.contactPhone].filter(Boolean).length
                      ? ` — ${[d.age ? `גיל ${d.age}` : '', d.city, d.contactPhone].filter(Boolean).join(' · ')}`
                      : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPreviewId(d.messageId)}
                    className="shrink-0 inline-flex items-center gap-1 text-brand-700 hover:underline"
                    title="פתח את הכרטיס המלא של הכפול הזה להשוואה"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    פתח כרטיס מלא
                  </button>
                </li>
              ))}
            </ul>
            <Button
              variant="primary"
              disabled={busy || !canApprove}
              leftIcon={<Copy className="h-4 w-4" />}
              onClick={() => onMergeDuplicates(fields)}
              title={canApprove ? 'יוצר מועמד אחד מהכרטיס הזה ומקשר אליו את שאר הכפולים' : 'חסר שם או טלפון — מלא לפני מיזוג'}
            >
              מזג הכל למועמד אחד
            </Button>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Original body */}
          <div className="space-y-2">
            <div>
              <div className="text-xs text-ink-muted mb-1">ההודעה המקורית</div>
              <div className="rounded-md border border-border bg-bg-subtle/40 p-2 text-sm whitespace-pre-wrap max-h-72 overflow-y-auto">
                {item.body}
              </div>
            </div>
            {item.mediaUrl && <MediaThumb url={item.mediaUrl} />}
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
              <EditRow label="שירות צבאי/לאומי"><Input value={fields.service ?? ''} onChange={(e) => set('service', e.target.value || undefined)} /></EditRow>
              <EditRow label="ישיבה/מדרשה"><Input value={fields.yeshiva ?? ''} onChange={(e) => set('yeshiva', e.target.value || undefined)} /></EditRow>
              <EditRow label="רמה דתית (טקסט)"><Input value={fields.religiousLevelText ?? ''} onChange={(e) => set('religiousLevelText', e.target.value || undefined)} /></EditRow>
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
              <EditRow label="משפחה" full>
                <Textarea rows={2} value={fields.family ?? ''} onChange={(e) => set('family', e.target.value || undefined)} />
              </EditRow>
            </div>
          </div>
        </div>

        <LearnLabelsPanel item={item} onTaught={onRerun} />

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
    <QueueItemPreviewDialog
      open={previewId !== null}
      onClose={() => setPreviewId(null)}
      item={previewId ? findQueueItem?.(previewId) : undefined}
      summary={previewId ? item.pendingDuplicates?.find((d) => d.messageId === previewId) : undefined}
    />
    </div>
  );
}

// ── Read-only full view of another queued card (duplicate compare) ──
// Opened from the "same person appears N times" panel so the operator can
// eyeball the OTHER card's full body + extracted fields before merging,
// without leaving the queue. Falls back to the summary row if the full
// item isn't in the loaded page (e.g. beyond the fetch limit).
function QueueItemPreviewDialog({ open, onClose, item, summary }: {
  open: boolean;
  onClose: () => void;
  item?: ReviewQueueItem;
  summary?: NonNullable<ReviewQueueItem['pendingDuplicates']>[number];
}) {
  const f = item?.extractedFields;
  const name = item
    ? `${f?.firstName ?? ''} ${f?.lastName ?? ''}`.trim() || 'ללא שם'
    : `${summary?.firstName ?? ''} ${summary?.lastName ?? ''}`.trim() || 'ללא שם';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`כרטיס מלא — ${name}`}
      secondaryAction={{ label: 'סגור', onClick: onClose }}
    >
      {!item ? (
        <div className="space-y-2 text-sm">
          <p className="text-ink-muted">הכרטיס המלא לא נטען (ייתכן שהוא מחוץ לעמוד הנוכחי). הנה מה שידוע:</p>
          <dl className="space-y-1">
            {summary?.age !== undefined && <CompareRow k="גיל" v={String(summary.age)} />}
            {summary?.city && <CompareRow k="עיר" v={summary.city} />}
            {summary?.contactPhone && <CompareRow k="טלפון" v={summary.contactPhone} />}
          </dl>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap text-xs text-ink-muted">
            <span>{new Date(item.createdAt).toLocaleString('he-IL')}</span>
            <span className="text-ink-faint">מ־{item.accountDisplayName}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-2">
              <div className="text-xs text-ink-muted">ההודעה המקורית</div>
              <div className="rounded-md border border-border bg-bg-subtle/40 p-2 text-sm whitespace-pre-wrap max-h-72 overflow-y-auto">
                {item.body || '—'}
              </div>
              {item.mediaUrl && <MediaThumb url={item.mediaUrl} />}
            </div>
            <div className="space-y-2">
              <div className="text-xs text-ink-muted">שדות שחולצו</div>
              <dl className="rounded-md border border-border bg-white p-3 space-y-1">
                {f?.age !== undefined && <CompareRow k="גיל" v={String(f.age)} />}
                {f?.height !== undefined && <CompareRow k="גובה" v={`${f.height} ס״מ`} />}
                {f?.city && <CompareRow k="עיר" v={f.city} />}
                {f?.edah && <CompareRow k="עדה" v={f.edah} />}
                {f?.sectorGroup && <CompareRow k="מגזר" v={label('sectorGroup', f.sectorGroup)} />}
                {f?.personalStatus && <CompareRow k="סטטוס" v={label('personalStatus', f.personalStatus)} />}
                {f?.occupation && <CompareRow k="עיסוק" v={f.occupation} />}
                {f?.yeshiva && <CompareRow k="ישיבה/מדרשה" v={f.yeshiva} />}
                {f?.service && <CompareRow k="שירות" v={f.service} />}
                {f?.contactPhones && f.contactPhones.length > 0 && <CompareRow k="טלפון" v={f.contactPhones.join(', ')} />}
                {f?.about && <CompareRow k="על עצמו" v={f.about} />}
                {f?.whatSeeking && <CompareRow k="מה מחפש" v={f.whatSeeking} />}
                {f?.family && <CompareRow k="משפחה" v={f.family} />}
              </dl>
            </div>
          </div>
        </div>
      )}
    </Dialog>
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

// ── Auth-aware media thumbnail → full-size Dialog ────────
function MediaThumb({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block" title="הצג תמונה מוגדלת">
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

// ── Duplicates tab: new extraction vs existing candidate ──
// Side-by-side comparison so the operator can decide: same person
// (link the message to the existing candidate) or a different one
// (create a new candidate from the extracted fields).
function DuplicateCard({
  item, focused, onLinkExisting, onCreateNew, onReject, busy,
}: {
  item: ReviewQueueItem;
  focused?: boolean;
  onLinkExisting: () => void;
  onCreateNew: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  useEffect(() => {
    if (focused && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focused]);

  const f = item.extractedFields;
  const s = item.suspectedCandidate!;
  const newName = `${f.firstName ?? ''} ${f.lastName ?? ''}`.trim() || 'ללא שם';
  const existingName = `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim() || 'ללא שם';

  // Identifying fields for the same-person decision. Each row carries the new
  // value and the existing value so both panels render from one list and each
  // cell can be tinted green (values agree — a same-person signal) or amber
  // (values disagree — a distinguishing signal). Rows empty on a side are
  // skipped there; rows empty on BOTH sides drop out entirely.
  const num = (n?: number) => (n !== undefined && n !== null ? String(n) : undefined);
  const joinPhones = (p?: string[]) => (p && p.length ? p.join(', ') : undefined);
  const compareRows: { k: string; nv?: string; ov?: string }[] = [
    { k: 'גיל', nv: num(f.age), ov: num(s.age) },
    { k: 'טלפון', nv: joinPhones(f.contactPhones), ov: s.contactPhone || undefined },
    { k: 'עיר', nv: f.city, ov: s.city },
    { k: 'אזור', ov: s.region ? label('region', s.region) : undefined },
    { k: 'שכונה', ov: s.neighborhood },
    { k: 'גובה', nv: num(f.height), ov: num(s.height) },
    { k: 'עדה', nv: f.edah, ov: s.ethnicity },
    { k: 'מין', nv: f.gender ? label('gender', f.gender) : undefined, ov: s.gender ? label('gender', s.gender) : undefined },
    { k: 'מגזר', nv: f.sectorGroup ? label('sectorGroup', f.sectorGroup) : undefined, ov: s.sectorGroup ? label('sectorGroup', s.sectorGroup) : undefined },
    { k: 'סטטוס', nv: f.personalStatus ? label('personalStatus', f.personalStatus) : undefined, ov: s.personalStatus ? label('personalStatus', s.personalStatus) : undefined },
    { k: 'עיסוק', nv: f.occupation, ov: s.occupation },
  ];

  return (
    <div ref={cardRef} className={focused ? 'ring-2 ring-brand-400 rounded-lg' : undefined}>
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="warning">
              {item.reviewReason ? REVIEW_REASON_LABEL[item.reviewReason] ?? item.reviewReason : REVIEW_REASON_LABEL.suspected_duplicate}
            </Badge>
            <SourceGroupControl item={item} />
            <span className="text-xs text-ink-muted">{new Date(item.createdAt).toLocaleString('he-IL')}</span>
            <span className="text-xs text-ink-faint">מ־{item.accountDisplayName}</span>
          </div>
          <Link to={`/chats?conversation=${item.conversationId}`} className="text-xs underline text-brand">
            פתח שיחה
          </Link>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* The newly extracted profile */}
          <div className="rounded-md border border-border bg-white p-3 space-y-2">
            <div className="text-xs font-semibold text-brand-700 uppercase tracking-wide">הפרופיל החדש שחולץ</div>
            <div className="text-sm font-medium">{newName}</div>
            <dl className="space-y-1">
              {compareRows
                .filter((r) => r.nv)
                .map((r) => (
                  <CompareRow key={r.k} k={r.k} v={r.nv!} tone={cmpTone(r.nv, r.ov)} />
                ))}
            </dl>
            {item.mediaUrl && <MediaThumb url={item.mediaUrl} />}
            {item.body && (
              <div className="rounded-md border border-border bg-bg-subtle/40 p-2 text-xs whitespace-pre-wrap max-h-36 overflow-y-auto">
                {item.body}
              </div>
            )}
          </div>

          {/* The suspected existing candidate */}
          <div className="rounded-md border border-amber-200 bg-amber-50/40 p-3 space-y-2">
            <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide">המועמד הקיים במאגר</div>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">{existingName}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCompareOpen(true)}
                  className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
                  title="פתח את הכרטיס המלא של המועמד הקיים להשוואה"
                >
                  <Eye className="h-3.5 w-3.5" />
                  פתח כרטיס מלא
                </button>
                <Link to={`/candidates/external/${s.id}`} className="text-xs text-brand-700 hover:underline">
                  פתח בעמוד
                </Link>
              </div>
            </div>
            <dl className="space-y-1">
              {compareRows
                .filter((r) => r.ov)
                .map((r) => (
                  <CompareRow key={r.k} k={r.k} v={r.ov!} tone={cmpTone(r.nv, r.ov)} />
                ))}
            </dl>
          </div>
        </div>

        <Divider />

        <div className="flex flex-wrap gap-2 justify-end">
          <Button variant="secondary" onClick={onReject} disabled={busy} leftIcon={<X className="h-4 w-4" />}>
            דחה (לא פרופיל)
          </Button>
          <Button variant="secondary" onClick={onCreateNew} disabled={busy} leftIcon={<UserPlus className="h-4 w-4" />}>
            אדם אחר — צור חדש
          </Button>
          <Button variant="primary" onClick={onLinkExisting} disabled={busy} leftIcon={<Link2 className="h-4 w-4" />}>
            אותו אדם — קשר לקיים
          </Button>
        </div>
      </CardBody>
    </Card>
    <ExternalCandidateDrawer id={compareOpen ? s.id : null} onClose={() => setCompareOpen(false)} />
    </div>
  );
}

// Same-person signal: does a field agree across the two profiles?
// 'match'  → both sides present and equal (strong same-person signal → green)
// 'diff'   → both sides present and differ (distinguishing signal → amber)
// undefined → only one side has the value; nothing to compare.
function cmpTone(nv?: string, ov?: string): 'match' | 'diff' | undefined {
  if (!nv || !ov) return undefined;
  const norm = (x: string) => x.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  return norm(nv) === norm(ov) ? 'match' : 'diff';
}

// Which WhatsApp group this card came from + who posted it, as a compact chip
// for the card's header row. Lets the operator trace a stream of junk/duplicate
// cards back to its source group and decide to unmap it. Text truncates so a
// long group name never breaks the header layout on mobile; the whole chip
// wraps to its own line when the header runs out of room. Hidden when there's
// no provenance (legacy/private-chat messages).
function SourceGroupChip({ item }: { item: ReviewQueueItem }) {
  const group = item.sourceGroupName?.trim();
  const sender = item.senderName?.trim() || item.senderPhone?.trim();
  if (!group && !sender) return null;
  const text = [group || 'קבוצה לא ממופה', sender && `פורסם ע״י ${sender}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-800">
      <Users className="h-3.5 w-3.5 shrink-0 text-brand-600" />
      <span className="truncate">{text}</span>
    </span>
  );
}

// Header control: the source-group chip + a "block this group" action. Opens a
// modal offering (a) ignore future cards only, or (b) ignore + purge the cards
// this group already has waiting in the queue. Both write the group's chat role
// to 'ignore' (ingestion gate then drops its future messages). Self-contained —
// owns its modal state and refetches the queue on success. The block action
// only shows when we know the chat JID to act on.
function SourceGroupControl({ item }: { item: ReviewQueueItem }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const chatJid = item.sourceChatJid?.trim();
  const groupLabel = item.sourceGroupName?.trim() || 'קבוצה זו';

  const ignore = useMutation({
    mutationFn: (purgeQueued: boolean) =>
      extractionApi.ignoreGroup({
        channelId: item.channelId,
        chatJid: chatJid!,
        chatName: item.sourceGroupName,
        purgeQueued,
      }),
    onSuccess: (res) => {
      const { purged } = res.data;
      toast.success(
        'הקבוצה סומנה להתעלמות',
        purged > 0
          ? `כרטיסים עתידיים ייחסמו · ${purged} כרטיסים הוסרו מהתור`
          : 'כרטיסים עתידיים מהקבוצה לא ייקלטו',
      );
      qc.invalidateQueries({ queryKey: ['extraction', 'review-queue'] });
      setOpen(false);
    },
    onError: (e: Error) => toast.error('סימון הקבוצה נכשל', e.message),
  });

  const closeIfIdle = () => { if (!ignore.isPending) setOpen(false); };

  return (
    <>
      <SourceGroupChip item={item} />
      {chatJid && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-700 hover:bg-red-50"
          title="חסום קבוצה זו — כרטיסים ממנה לא ייקלטו למאגר"
        >
          <Ban className="h-3.5 w-3.5 shrink-0" />
          התעלם מקבוצה
        </button>
      )}
      <Dialog
        open={open}
        onClose={closeIfIdle}
        title="התעלם מקבוצה זו"
        description={`${groupLabel} — כרטיסים מקבוצה זו יסוננו בשער הקליטה ולא ייקלטו למאגר.`}
        secondaryAction={{ label: 'ביטול', onClick: closeIfIdle }}
      >
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={ignore.isPending}
            onClick={() => ignore.mutate(false)}
            className="rounded-lg border border-border p-3 text-start hover:border-brand-400 hover:bg-brand-50/40 disabled:opacity-50"
          >
            <div className="text-sm font-medium text-ink">התעלם מעכשיו והלאה</div>
            <div className="text-xs text-ink-muted">רק כרטיסים חדשים שיגיעו מהקבוצה ייחסמו. מה שכבר בתור יישאר.</div>
          </button>
          <button
            type="button"
            disabled={ignore.isPending}
            onClick={() => ignore.mutate(true)}
            className="rounded-lg border border-red-200 p-3 text-start hover:border-red-400 hover:bg-red-50/50 disabled:opacity-50"
          >
            <div className="text-sm font-medium text-red-800">התעלם, והסר גם את מה שבתור</div>
            <div className="text-xs text-ink-muted">חוסם כרטיסים עתידיים, ובנוסף מסיר מהתור את כל הכרטיסים מקבוצה זו שממתינים לסקירה/כפולים (יסומנו כלא-פרופיל).</div>
          </button>
        </div>
      </Dialog>
    </>
  );
}

function CompareRow({ k, v, tone }: { k: string; v: string; tone?: 'match' | 'diff' }) {
  const valueClass =
    tone === 'match'
      ? 'text-emerald-700 font-medium'
      : tone === 'diff'
        ? 'text-amber-700'
        : 'text-ink';
  return (
    <div className="flex gap-2 text-xs">
      <dt className="text-ink-faint min-w-[3.5rem]">{k}</dt>
      <dd className={`${valueClass} flex-1`}>{v}</dd>
    </div>
  );
}
