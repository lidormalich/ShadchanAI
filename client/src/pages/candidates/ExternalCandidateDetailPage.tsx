// ═══════════════════════════════════════════════════════════
// ExternalCandidateDetailPage — full-page view for an external
// candidate (route: /candidates/external/:id). Reached from the
// offers box, find-matches dialog, compatibility board, chats and
// Ask-AI "פרופיל" links.
//
//   • "ניתוח התאמה" tab — actionable: accept an offer (creates a
//      suggestion draft) or reject it (records a not_suitable pair
//      review so it is not offered again).
//   • "הצעות שידוך" tab — existing MatchSuggestions for this
//      external with inline status management (approve / defer /
//      close) and a link into the full match manager (/matches/:id)
//      where the rest of the lifecycle — sent → accepted → dating —
//      is driven.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, CheckCircle2, Clock, MapPin, Pencil, RotateCcw, Share2, UserX, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Avatar, Badge, Button, Card, CardBody, CardHeader, Divider, Select, Tabs, Textarea } from '@/components/ui/primitives';
import { ConfirmActionModal, Dialog } from '@/components/ui/Dialog';
import { externalCandidatesApi } from '@/services/api/candidates';
import { matchesApi } from '@/services/api/matches';
import { pairReviewsApi } from '@/services/api/pair-reviews';
import { ExternalCandidateForm } from '@/features/forms/ExternalCandidateForm';
import { CreateSuggestionDialog } from '@/features/matching/CreateSuggestionDialog';
import { StatusReasonDialog } from '@/features/matches/StatusReasonDialog';
import { FullProfile, ShareCardPreview, buildExternalCardText } from './ExternalCandidateDrawer';
import { SourceCardTab } from '@/features/candidates/SourceCardTab';
import { PhotoTab } from '@/features/candidates/PhotoTab';
import { StaleBanner } from '@/components/domain/banners';
import { EntityTimeline } from '@/features/history/EntityTimeline';
import { NotesRail } from '@/features/notes/NotesRail';
import { TasksRail } from '@/features/tasks/TasksRail';
import { OwnerChip } from '@/features/users/OwnerChip';
import { EmptyState, ErrorState, LoadingSkeleton, NotFoundState } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { useSetPageTitle } from '@/layouts/PageTitleContext';
import { isNotFoundError } from '@/utils/apiError';
import { label } from '@/utils/labels';
import { formatDate } from '@/utils/format';
import type { MatchSuggestion } from '@/types/domain';

export function ExternalCandidateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [createSuggestionOpen, setCreateSuggestionOpen] = useState(false);
  const [notRelevantOpen, setNotRelevantOpen] = useState(false);

  const ext = useQuery({
    queryKey: ['external', id],
    queryFn: () => externalCandidatesApi.get(id!),
    enabled: !!id,
  });
  const matching = useQuery({
    queryKey: ['external', id, 'matching'],
    queryFn: () => externalCandidatesApi.matchingInternals(id!, { limit: 25 }),
    enabled: !!id,
  });
  const suggestions = useQuery({
    queryKey: ['external', id, 'suggestions'],
    queryFn: () => matchesApi.list({ externalCandidateId: id!, limit: 50, sort: 'updatedAt', order: 'desc' }),
    enabled: !!id,
  });

  // Bring a previously "not relevant" external back into the matching pool.
  const reactivate = useMutation({
    mutationFn: () => externalCandidatesApi.updateAvailability(id!, { availabilityStatus: 'available', confirmAvailable: true }),
    onSuccess: () => {
      toast.success('המועמד הוחזר לזמינות', 'יופיע שוב בסריקות ובהתאמות');
      qc.invalidateQueries({ queryKey: ['external', id] });
      qc.invalidateQueries({ queryKey: ['scan-results'] });
      qc.invalidateQueries({ queryKey: ['matches'] });
    },
    onError: (err) => toast.error('ההחזרה נכשלה', (err as Error).message),
  });

  const c = ext.data?.data;
  useSetPageTitle(c ? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'מועמד חיצוני' : undefined);

  if (ext.isLoading) return <div className="p-6"><LoadingSkeleton rows={8} /></div>;
  if (ext.isError) {
    return isNotFoundError(ext.error)
      ? <NotFoundState title="מועמד לא נמצא" description="המועמד החיצוני המבוקש לא קיים או הוסר מהמאגר." backTo="/candidates/external" backLabel="חזרה למועמדים חיצוניים" />
      : <ErrorState description={(ext.error as Error).message} onRetry={() => ext.refetch()} />;
  }
  if (!c) return null;

  const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'מועמד חיצוני';
  const suggestionItems = (suggestions.data?.data ?? []) as MatchSuggestionRow[];

  return (
    <div className="space-y-4">
      {/* Sticky header */}
      <Card className="sticky top-0 z-10">
        <CardBody className="flex items-center gap-4 flex-wrap">
          {/* Operator always sees the photo; sharePhoto gates only outbound sharing. */}
          <Avatar name={name} size={56} src={c.photoUrl} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold">{name}</h1>
              <Badge tone={c.availabilityStatus === 'available' ? 'success' : c.availabilityStatus === 'dating' ? 'purple' : 'warning'}>
                {label('availabilityStatus', c.availabilityStatus)}
              </Badge>
              {c.sectorGroup && <Badge tone="neutral">{label('sectorGroup', c.sectorGroup)}</Badge>}
              {c.subSector && <Badge tone="neutral">{label('subSector', c.subSector)}</Badge>}
              {c.staleAt && <Badge tone="warning">ישן</Badge>}
            </div>
            <div className="mt-1 text-sm text-ink-muted flex items-center gap-3 flex-wrap">
              {c.city && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{c.city}</span>}
              {c.age && <span className="inline-flex items-center gap-1 num"><Calendar className="h-3.5 w-3.5" />{c.age}</span>}
              <span>מקור: {c.sourceName ?? label('sourceType', c.sourceType)}</span>
              <OwnerChip userId={c.ownerUserId} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" leftIcon={<Pencil className="h-4 w-4" />} onClick={() => setEditOpen(true)}>עריכה</Button>
            {c.availabilityStatus === 'unavailable' ? (
              <Button
                variant="secondary"
                leftIcon={<RotateCcw className="h-4 w-4" />}
                loading={reactivate.isPending}
                onClick={() => reactivate.mutate()}
              >
                החזר לזמינות
              </Button>
            ) : (
              <Button
                variant="secondary"
                leftIcon={<UserX className="h-4 w-4" />}
                onClick={() => setNotRelevantOpen(true)}
              >
                סמן כלא רלוונטי
              </Button>
            )}
            <Button leftIcon={<Share2 className="h-4 w-4" />} onClick={() => setCreateSuggestionOpen(true)}>צור הצעת שידוך</Button>
          </div>
        </CardBody>
      </Card>

      {c.staleAt && <StaleBanner />}

      {/* Main 3-column layout */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 space-y-4">
          <Tabs
            tabs={[
              { id: 'profile', label: 'פרופיל מלא', content: <FullProfile c={c} /> },
              {
                id: 'photo',
                label: 'תמונה',
                content: (
                  <PhotoTab
                    type="external"
                    candidateId={c._id}
                    name={name}
                    photoUrl={c.photoUrl}
                    cardText={buildExternalCardText(c)}
                  />
                ),
              },
              {
                id: 'match',
                label: 'ניתוח התאמה',
                badge: <Badge tone="brand">{matching.data?.data.length ?? 0}</Badge>,
                content: (
                  <MatchingInternals
                    externalCandidateId={c._id}
                    items={matching.data?.data ?? []}
                    loading={matching.isLoading}
                  />
                ),
              },
              {
                id: 'suggestions',
                label: 'הצעות שידוך',
                badge: <Badge tone="brand">{suggestionItems.length}</Badge>,
                content: <SuggestionsList items={suggestionItems} loading={suggestions.isLoading} />,
              },
              { id: 'share', label: 'תצוגה מקדימה לשיתוף', content: <ShareCardPreview c={c} /> },
              { id: 'source', label: 'כרטיס מקורי', content: <SourceCardTab kind="external" candidateId={c._id} /> },
              { id: 'history', label: 'היסטוריה', content: <EntityTimeline entityType="external_candidate" entityId={c._id} title="יומן פעילות" asCard={false} /> },
            ]}
          />
        </div>

        {/* Right rail */}
        <aside className="space-y-4">
          <Card>
            <CardHeader><h3 className="text-sm font-semibold">פרטי מקור</h3></CardHeader>
            <CardBody className="space-y-2 text-sm">
              <MetricRow label="זמינות" value={label('availabilityStatus', c.availabilityStatus)} />
              <MetricRow label="מקור" value={c.sourceName ?? label('sourceType', c.sourceType)} />
              {c.sourceMatchmakerName && <MetricRow label="שדכן מקור" value={c.sourceMatchmakerName} />}
              {c.sourceGroupName && <MetricRow label="קבוצת WhatsApp" value={c.sourceGroupName} />}
              {c.sourceSenderName && <MetricRow label="נשלח ע״י" value={c.sourceSenderName} />}
              {c.sourceSenderPhone && <MetricRow label="טלפון השולח" value={c.sourceSenderPhone} />}
              <Divider />
              <MetricRow label="עודכן ממקור" value={formatDate(c.lastSourceUpdateAt)} />
            </CardBody>
          </Card>
          <TasksRail related={{ type: 'external_candidate', id: c._id }} />
          <NotesRail entityType="external_candidate" entityId={c._id} />
        </aside>
      </div>

      <ExternalCandidateForm open={editOpen} onClose={() => setEditOpen(false)} initial={c} />
      <CreateSuggestionDialog open={createSuggestionOpen} onClose={() => setCreateSuggestionOpen(false)} initialExternal={c} />

      <MarkExternalNotRelevantDialog
        open={notRelevantOpen}
        onClose={() => setNotRelevantOpen(false)}
        candidateId={c._id}
        candidateName={name}
      />
    </div>
  );
}

// Marks an external candidate as "no longer relevant" by setting availability
// to 'unavailable' — the scan only considers available/unknown externals, so
// they drop out of all results. Reversible via "החזר לזמינות".
const EXTERNAL_NOT_RELEVANT_REASONS = ['married', 'engaged', 'not_interested', 'other'];

function MarkExternalNotRelevantDialog({
  open, onClose, candidateId, candidateName,
}: {
  open: boolean;
  onClose: () => void;
  candidateId: string;
  candidateName: string;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('married');
  const [note, setNote] = useState('');

  const mark = useMutation({
    mutationFn: () => externalCandidatesApi.updateAvailability(candidateId, {
      availabilityStatus: 'unavailable',
      staleReason: [label('closureReason', reason), note.trim()].filter(Boolean).join(' — '),
    }),
    onSuccess: () => {
      toast.success('המועמד סומן כלא רלוונטי', 'לא יופיע יותר בסריקות ובהתאמות');
      qc.invalidateQueries({ queryKey: ['external', candidateId] });
      qc.invalidateQueries({ queryKey: ['scan-results'] });
      qc.invalidateQueries({ queryKey: ['matches'] });
      onClose();
    },
    onError: (err) => toast.error('הפעולה נכשלה', (err as Error).message),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="סימון מועמד כלא רלוונטי"
      description={`${candidateName} יוסר מכל הסריקות וההתאמות. ניתן להחזיר לזמינות בכל עת.`}
      primaryAction={{ label: 'סמן כלא רלוונטי', onClick: () => mark.mutate(), loading: mark.isPending, variant: 'danger' }}
      secondaryAction={{ label: 'ביטול', onClick: onClose }}
    >
      <div className="space-y-3">
        <div>
          <div className="text-xs text-ink-muted mb-1">סיבה</div>
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {EXTERNAL_NOT_RELEVANT_REASONS.map((r) => (
              <option key={r} value={r}>{label('closureReason', r)}</option>
            ))}
          </Select>
        </div>
        <div>
          <div className="text-xs text-ink-muted mb-1">הערה (אופציונלי)</div>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="פרטים נוספים…" />
        </div>
      </div>
    </Dialog>
  );
}

// ── Matching internals (actionable: accept → draft, reject → review) ──

type MatchingRow = {
  internalCandidate?: { id?: string; firstName?: string; lastName?: string };
  matchScore?: number;
  confidenceScore?: number;
  matchType?: string;
};

function MatchingInternals({
  externalCandidateId, items, loading,
}: {
  externalCandidateId: string;
  items: unknown[];
  loading: boolean;
}) {
  if (loading) return <LoadingSkeleton rows={4} />;
  if (!items.length) {
    return <EmptyState title="לא נמצאו התאמות פנימיות" description="ייתכן שהצדדים אינם עומדים ברף, או שהפרופיל חסר נתונים." />;
  }
  return (
    <ul className="space-y-2">
      {(items as MatchingRow[]).map((r, i) => (
        <MatchingInternalRow key={r.internalCandidate?.id ?? i} row={r} externalCandidateId={externalCandidateId} />
      ))}
    </ul>
  );
}

function MatchingInternalRow({ row, externalCandidateId }: { row: MatchingRow; externalCandidateId: string }) {
  const qc = useQueryClient();
  const internalId = row.internalCandidate?.id;
  const internalName = `${row.internalCandidate?.firstName ?? ''} ${row.internalCandidate?.lastName ?? ''}`.trim() || 'פנימי';

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['external', externalCandidateId, 'suggestions'] });
    qc.invalidateQueries({ queryKey: ['external', externalCandidateId, 'matching'] });
    qc.invalidateQueries({ queryKey: ['matches'] });
  };

  const accept = useMutation({
    mutationFn: () => matchesApi.createManual({ internalCandidateId: internalId!, externalCandidateId, mode: 'discovery' }),
    onSuccess: () => { toast.success('ההצעה התקבלה', 'נוצרה טיוטה — נהל אותה בלשונית "הצעות שידוך"'); invalidate(); },
    onError: (e) => toast.error('הקבלה נכשלה', (e as Error).message),
  });
  const reject = useMutation({
    mutationFn: () => pairReviewsApi.upsert(internalId!, externalCandidateId, {
      manualStatus: 'not_suitable',
      operatorReason: 'נדחה מפרופיל המועמד',
    }),
    onSuccess: () => { toast.success('ההצעה נדחתה', 'לא תוצע שוב'); invalidate(); },
    onError: (e) => toast.error('הדחייה נכשלה', (e as Error).message),
  });

  const busy = accept.isPending || reject.isPending;

  return (
    <li className="rounded-md border border-border bg-white p-3 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{internalName}</div>
        <div className="text-xs text-ink-muted">
          <Badge tone={row.matchType === 'safe' ? 'success' : row.matchType === 'balanced' ? 'brand' : 'warning'}>
            {label('matchType', row.matchType)}
          </Badge>
        </div>
      </div>
      <div className="text-end shrink-0 w-14">
        <div className="text-lg font-semibold num text-brand-700">{row.matchScore ?? '—'}</div>
        <div className="text-[11px] text-ink-faint num">ביטחון {row.confidenceScore ?? '—'}</div>
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        <Button size="sm" loading={accept.isPending} disabled={busy || !internalId} onClick={() => accept.mutate()}>קבל</Button>
        <Button size="sm" variant="ghost" loading={reject.isPending} disabled={busy || !internalId} onClick={() => reject.mutate()}>דחה</Button>
        {internalId && (
          <Link to={`/candidates/internal/${internalId}`} className="text-xs text-ink-muted hover:underline">פרופיל</Link>
        )}
      </div>
    </li>
  );
}

// ── Existing suggestions for this external (inline status management) ──

type MatchSuggestionRow = MatchSuggestion & { internalName?: string };

function SuggestionsList({ items, loading }: { items: MatchSuggestionRow[]; loading: boolean }) {
  if (loading) return <LoadingSkeleton rows={4} />;
  if (!items.length) {
    return <EmptyState title="אין הצעות שידוך" description="קבל הצעה מלשונית 'ניתוח התאמה' או צור הצעה ידנית." />;
  }
  return (
    <ul className="space-y-2">
      {items.map((m) => <SuggestionRow key={m._id} m={m} />)}
    </ul>
  );
}

// Statuses past the operator-decision stage are driven from the full
// match manager (/matches/:id) only — sending, response tracking, dating.
const DECIDABLE = new Set(['draft', 'pending_approval', 'deferred']);

function SuggestionRow({ m }: { m: MatchSuggestionRow }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<null | { type: 'defer' | 'close'; title: string; desc?: string }>(null);
  const [approveReasonOpen, setApproveReasonOpen] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['external', m.externalCandidateId, 'suggestions'] });
    qc.invalidateQueries({ queryKey: ['matches'] });
  };

  const approve = useMutation({
    mutationFn: (reason?: string) => matchesApi.approve(m._id, reason ? { reason } : {}),
    onSuccess: () => { toast.success('ההצעה אושרה'); invalidate(); },
    onError: (e) => toast.error('האישור נכשל', (e as Error).message),
  });
  const defer = useMutation({
    mutationFn: () => matchesApi.defer(m._id, { reason: 'הושהה מפרופיל המועמד' }),
    onSuccess: () => { toast.success('ההצעה הושהתה'); invalidate(); },
    onError: (e) => toast.error('ההשהיה נכשלה', (e as Error).message),
  });
  const reopen = useMutation({
    mutationFn: () => matchesApi.reopenDeferred(m._id),
    onSuccess: () => { toast.success('ההצעה הוחזרה לתור'); invalidate(); },
    onError: (e) => toast.error('הפעולה נכשלה', (e as Error).message),
  });
  const close = useMutation({
    mutationFn: () => matchesApi.close(m._id, { reason: 'נסגר מפרופיל המועמד' }),
    onSuccess: () => { toast.success('ההצעה נסגרה'); invalidate(); },
    onError: (e) => toast.error('הסגירה נכשלה', (e as Error).message),
  });

  const busy = approve.isPending || defer.isPending || reopen.isPending || close.isPending;
  const canDecide = DECIDABLE.has(m.status);

  return (
    <li className="rounded-md border border-border bg-white p-3 flex items-center gap-3 flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{m.internalName ?? m.internalCandidateId.slice(-8)}</div>
        <div className="text-xs text-ink-muted flex items-center gap-2 flex-wrap mt-0.5">
          <Badge tone={m.matchType === 'safe' ? 'success' : m.matchType === 'balanced' ? 'brand' : 'warning'}>
            {label('matchType', m.matchType)}
          </Badge>
          <Badge tone={m.isDeferred ? 'warning' : 'neutral'}>{label('matchStatus', m.status)}</Badge>
        </div>
      </div>
      <div className="text-end shrink-0 w-14">
        <div className="text-lg font-semibold num text-brand-700">{m.matchScore}</div>
        <div className="text-[11px] text-ink-faint num">ביטחון {m.confidenceScore}</div>
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        {m.status === 'deferred' ? (
          <Button size="sm" variant="secondary" loading={reopen.isPending} disabled={busy} onClick={() => reopen.mutate()}>החזר לתור</Button>
        ) : canDecide && (
          <>
            <Button size="sm" leftIcon={<CheckCircle2 className="h-3.5 w-3.5" />} loading={approve.isPending} disabled={busy}
              onClick={() => setApproveReasonOpen(true)}>אשר</Button>
            <Button size="sm" variant="ghost" leftIcon={<Clock className="h-3.5 w-3.5" />} loading={defer.isPending} disabled={busy}
              onClick={() => setConfirm({ type: 'defer', title: 'השהה הצעה', desc: 'ההצעה תעבור לתור המושהות. ניתן להחזיר בהמשך.' })}>השהה</Button>
          </>
        )}
        <Button size="sm" variant="ghost" leftIcon={<XCircle className="h-3.5 w-3.5" />} loading={close.isPending} disabled={busy}
          onClick={() => setConfirm({ type: 'close', title: 'סגור הצעה', desc: 'ההצעה תיסגר ולא תופיע כפעילה.' })}>דחה</Button>
        <Link to={`/matches/${m._id}`} className="text-xs text-brand-700 hover:underline">נהל</Link>
      </div>

      <ConfirmActionModal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.title ?? ''}
        description={confirm?.desc}
        onConfirm={() => {
          if (confirm?.type === 'defer') defer.mutate();
          if (confirm?.type === 'close') close.mutate();
          setConfirm(null);
        }}
      />

      <StatusReasonDialog
        open={approveReasonOpen}
        title="אשר הצעה"
        onClose={() => setApproveReasonOpen(false)}
        onConfirm={(reason) => {
          setApproveReasonOpen(false);
          approve.mutate(reason);
        }}
      />
    </li>
  );
}

function MetricRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="text-ink font-medium">{value}</span>
    </div>
  );
}
