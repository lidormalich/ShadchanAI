import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, Mail, MapPin, Phone, RotateCcw, Search, Sparkles, UserX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Button, Card, CardBody, CardHeader, Divider, Select, TBody, THead, Table, Td, Textarea, Th, Tr, Tabs } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { internalCandidatesApi } from '@/services/api/candidates';
import { matchesApi, type FindMatchItem } from '@/services/api/matches';
import { aiApi, buildCandidateBrief } from '@/services/api/ai';
import { AskAIPanel } from '@/features/ai/AskAIPanel';
import { InternalCandidateForm } from '@/features/forms/InternalCandidateForm';
import { NotesRail } from '@/features/notes/NotesRail';
import { TasksRail } from '@/features/tasks/TasksRail';
import { EntityTimeline } from '@/features/history/EntityTimeline';
import { OwnerChip } from '@/features/users/OwnerChip';
import { BlockedCandidatesList } from '@/features/matching/BlockedCandidatesList';
import { isTerminalMatchStatus } from '@/utils/matchStatus';
import { CompatibilityWorkspace } from '@/features/compatibility/CompatibilityWorkspace';
import { SourceCardTab } from '@/features/candidates/SourceCardTab';
import { CandidatePhoto } from '@/features/candidates/CandidatePhoto';
import { PhotoTab } from '@/features/candidates/PhotoTab';
import { CandidateInsightTab } from '@/features/candidates/CandidateInsightTab';
import { InsightFitBadge, useInsightFits } from '@/features/matches/InsightFitBadge';
import { ReadinessIndicator } from '@/components/domain/ReadinessIndicator';
import { ClosedBanner, DatingStatusBanner, DeferredSuggestionsBanner } from '@/components/domain/banners';
import { EmptyState, ErrorState, LoadingSkeleton, NotFoundState } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { useSetPageTitle } from '@/layouts/PageTitleContext';
import { isNotFoundError } from '@/utils/apiError';
import { label, matchTypeTone } from '@/utils/labels';
import { formatDate, formatDateTime } from '@/utils/format';
import type { MatchSuggestion, Conversation, InternalCandidate } from '@/types/domain';

export function InternalCandidateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [findOpen, setFindOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [notRelevantOpen, setNotRelevantOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const candidate = useQuery({
    queryKey: ['internal', id],
    queryFn: () => internalCandidatesApi.get(id!),
    enabled: !!id,
  });
  const readiness = useQuery({
    queryKey: ['internal', id, 'readiness'],
    queryFn: () => internalCandidatesApi.readiness(id!),
    enabled: !!id,
  });
  const suggestions = useQuery({
    queryKey: ['internal', id, 'suggestions'],
    queryFn: () => internalCandidatesApi.suggestions(id!),
    enabled: !!id,
  });
  const conversations = useQuery({
    queryKey: ['internal', id, 'conversations'],
    queryFn: () => internalCandidatesApi.conversations(id!),
    enabled: !!id,
  });

  // Bring a previously "not relevant" candidate back into the matching pool.
  const reopen = useMutation({
    mutationFn: () => internalCandidatesApi.reopen(id!, { reason: 'חזר להיות רלוונטי' }),
    onSuccess: () => {
      toast.success('המועמד הוחזר לפעילות', 'יופיע שוב בסריקות ובהתאמות');
      qc.invalidateQueries({ queryKey: ['internal', id] });
      qc.invalidateQueries({ queryKey: ['scan-results'] });
      qc.invalidateQueries({ queryKey: ['matches'] });
    },
    onError: (err) => toast.error('ההחזרה נכשלה', (err as Error).message),
  });

  const summarize = useMutation({
    mutationFn: async (doc: InternalCandidate) => aiApi.summarizeCandidate({ candidate: buildCandidateBrief(doc) }),
    onSuccess: (r) => {
      const d = r.data as { summary?: string; communicationStyle?: string; warnings?: string[] };
      toast.info('סיכום AI', [d.summary, d.communicationStyle, ...(d.warnings ?? [])].filter(Boolean).join('\n\n'));
    },
    onError: (err) => toast.error('סיכום נכשל', (err as Error).message),
  });

  // Breadcrumb shows the candidate's name instead of the raw id from the URL.
  const cd = candidate.data?.data;
  useSetPageTitle(cd ? `${cd.firstName} ${cd.lastName}`.trim() : undefined);

  if (candidate.isLoading) return <div className="p-6"><LoadingSkeleton rows={8} /></div>;
  if (candidate.isError) {
    return isNotFoundError(candidate.error)
      ? <NotFoundState title="מועמד לא נמצא" description="המועמד המבוקש לא קיים או הוסר מהמאגר." backTo="/candidates/internal" backLabel="חזרה למועמדים" />
      : <ErrorState description={(candidate.error as Error).message} onRetry={() => candidate.refetch()} />;
  }
  if (!candidate.data) return null;

  const c = candidate.data.data;
  const isDating = c.status === 'dating';
  const isClosed = c.status === 'closed';

  return (
    <div className="space-y-4">
      {/* Sticky header */}
      <Card className="sticky top-0 z-10">
        <CardBody className="flex items-center gap-4">
          <CandidatePhoto candidateId={c._id} name={`${c.firstName} ${c.lastName}`} photoUrl={c.photoUrl} size={56} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold">{c.firstName} {c.lastName}</h1>
              <Badge tone={c.status === 'active' ? 'success' : c.status === 'dating' ? 'purple' : 'neutral'}>{label('candidateStatus', c.status)}</Badge>
              <Badge tone="neutral">{label('sectorGroup', c.sectorGroup)}</Badge>
              {c.subSector && <Badge tone="neutral">{label('subSector', c.subSector)}</Badge>}
            </div>
            <div className="mt-1 text-sm text-ink-muted flex items-center gap-3 flex-wrap">
              {c.city && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{c.city}</span>}
              {c.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{c.phone}</span>}
              {c.email && <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" />{c.email}</span>}
              <span className="inline-flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />{formatDate(c.dateOfBirth)}</span>
              <OwnerChip userId={c.ownerUserId} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              leftIcon={<Search className="h-4 w-4" />}
              onClick={() => setFindOpen(true)}
            >
              חפש התאמות
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Sparkles className="h-4 w-4" />}
              loading={summarize.isPending}
              onClick={() => summarize.mutate(c)}
            >
              סיכום AI
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Sparkles className="h-4 w-4" />}
              onClick={() => setAskOpen(true)}
            >
              שאל את ה-AI
            </Button>
            <Button variant="secondary" onClick={() => setEditOpen(true)}>עריכה</Button>
            {isClosed ? (
              <Button
                variant="secondary"
                leftIcon={<RotateCcw className="h-4 w-4" />}
                loading={reopen.isPending}
                onClick={() => reopen.mutate()}
              >
                החזר לפעילות
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
          </div>
        </CardBody>
      </Card>

      {/* Banners */}
      {isDating && <DatingStatusBanner partnerName={c.datingPartnerCandidateId?.slice(-6)} startedAt={c.datingStartedAt} />}
      {isClosed && <ClosedBanner reason={c.closureReason} closedAt={c.closedAt} />}
      {c.deferredSuggestionsCount > 0 && <DeferredSuggestionsBanner count={c.deferredSuggestionsCount} />}

      {/* Main 3-column layout */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Left: profile sections */}
        <div className="xl:col-span-2 space-y-4">
          <Tabs
            tabs={[
              {
                id: 'profile',
                label: 'פרופיל',
                content: <ProfileSections c={candidate.data.data} />,
              },
              {
                id: 'photo',
                label: 'תמונה',
                content: (
                  <PhotoTab
                    type="internal"
                    candidateId={c._id}
                    name={`${c.firstName} ${c.lastName}`}
                    photoUrl={c.photoUrl}
                    cardText={buildInternalCardText(c)}
                  />
                ),
              },
              {
                id: 'compatibility',
                label: 'התאמה',
                content: <CompatibilityWorkspace internalCandidateId={c._id} />,
              },
              {
                id: 'suggestions',
                label: 'הצעות שידוך',
                // Count only LIVE suggestions — closed/expired/declined ones
                // still list as history but shouldn't inflate the badge.
                badge: <Badge tone="brand">{(suggestions.data?.data ?? []).filter((s) => !isTerminalMatchStatus(s.status)).length}</Badge>,
                content: <SuggestionsTable items={suggestions.data?.data ?? []} loading={suggestions.isLoading} />,
              },
              {
                id: 'conversations',
                label: 'שיחות',
                badge: <Badge tone="neutral">{conversations.data?.data.length ?? 0}</Badge>,
                content: <LinkedConversations items={conversations.data?.data ?? []} loading={conversations.isLoading} />,
              },
              {
                id: 'insight',
                label: 'מה למדנו',
                content: <CandidateInsightTab candidateId={c._id} />,
              },
              {
                id: 'source',
                label: 'כרטיס מקורי',
                content: <SourceCardTab kind="internal" candidateId={c._id} />,
              },
              {
                id: 'history',
                label: 'היסטוריה',
                content: <EntityTimeline entityType="internal_candidate" entityId={c._id} title="יומן פעילות" asCard={false} />,
              },
            ]}
          />
        </div>

        {/* Right: activity rail */}
        <aside className="space-y-4">
          {readiness.data && <ReadinessIndicator readiness={readiness.data.data} />}
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold">מדדי איכות</h3>
            </CardHeader>
            <CardBody className="space-y-2 text-sm">
              <MetricRow label="איכות פרופיל" value={c.profileQualityScore ?? '—'} />
              <MetricRow label="מהימנות מידע" value={c.dataReliabilityScore ?? '—'} />
              <MetricRow label="ציון מוכנות" value={c.readinessScore ?? '—'} />
              <Divider />
              <MetricRow label="נוצר" value={formatDateTime(c.createdAt)} />
              <MetricRow label="עודכן" value={formatDateTime(c.updatedAt ?? c.createdAt)} />
              <MetricRow label="פעולה אחרונה" value={formatDate(c.lastActionAt)} />
              <MetricRow label="אומת לאחרונה" value={formatDate(c.lastVerifiedAt)} />
            </CardBody>
          </Card>
          <TasksRail related={{ type: 'internal_candidate', id: c._id }} />
          <NotesRail entityType="internal_candidate" entityId={c._id} />
        </aside>
      </div>

      <FindMatchesDialog
        open={findOpen}
        onClose={() => setFindOpen(false)}
        internalCandidateId={c._id}
      />

      <InternalCandidateForm
        open={editOpen}
        onClose={() => setEditOpen(false)}
        initial={c}
      />

      <MarkNotRelevantDialog
        open={notRelevantOpen}
        onClose={() => setNotRelevantOpen(false)}
        candidateId={c._id}
        candidateName={`${c.firstName} ${c.lastName}`.trim()}
      />

      <AskAIPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        initialQuery={`מי המועמדים המתאימים ביותר עבור ${c.firstName} ${c.lastName}?`.trim()}
        contextId={c._id}
      />
    </div>
  );
}

// Marks an internal candidate as "no longer relevant" — closes them with a
// reason so they drop out of every scan and matching result (the engine only
// considers status:'active' candidates). Reversible via "החזר לפעילות".
const NOT_RELEVANT_REASONS = [
  'married', 'engaged', 'not_interested', 'taking_break', 'left_system', 'shadchan_decision', 'other',
];

function MarkNotRelevantDialog({
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

  const close = useMutation({
    mutationFn: () => internalCandidatesApi.close(candidateId, { reason, note: note.trim() || undefined }),
    onSuccess: () => {
      toast.success('המועמד סומן כלא רלוונטי', 'לא יופיע יותר בסריקות ובהתאמות');
      qc.invalidateQueries({ queryKey: ['internal', candidateId] });
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
      description={`${candidateName} יוסר מכל הסריקות וההתאמות. ניתן להחזיר לפעילות בכל עת.`}
      primaryAction={{ label: 'סמן כלא רלוונטי', onClick: () => close.mutate(), loading: close.isPending, variant: 'danger' }}
      secondaryAction={{ label: 'ביטול', onClick: onClose }}
    >
      <div className="space-y-3">
        <div>
          <div className="text-xs text-ink-muted mb-1">סיבה</div>
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {NOT_RELEVANT_REASONS.map((r) => (
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

function FindMatchesDialog({
  open, onClose, internalCandidateId,
}: {
  open: boolean;
  onClose: () => void;
  internalCandidateId: string;
}) {
  const qc = useQueryClient();
  // No `limit` → the engine returns every eligible scored match. We load them
  // into the list in chunks so a large pool doesn't render all at once.
  const q = useQuery({
    queryKey: ['find-matches', internalCandidateId, open],
    queryFn: () => matchesApi.findForInternal(internalCandidateId),
    enabled: open,
  });

  const CHUNK = 10;
  const [visibleCount, setVisibleCount] = useState(CHUNK);
  const allMatches = q.data?.data ?? [];
  // Reset the visible window whenever the dialog reopens or the result set changes.
  useEffect(() => { setVisibleCount(CHUNK); }, [open, allMatches.length]);

  // Advisory ⭐ insight-fit for every candidate in the pool (one batch call).
  const insightPairs = allMatches.map((m) => ({ internalCandidateId, externalCandidateId: m.externalCandidateId }));
  const { fitFor } = useInsightFits(insightPairs);

  const createSuggestion = useMutation({
    mutationFn: (externalCandidateId: string) => matchesApi.createManual({
      internalCandidateId, externalCandidateId, mode: 'strict',
    }),
    onSuccess: () => {
      toast.success('הצעת שידוך נוצרה');
      qc.invalidateQueries({ queryKey: ['internal', internalCandidateId, 'suggestions'] });
    },
    onError: (err) => toast.error('יצירת הצעה נכשלה', (err as Error).message),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="חיפוש התאמות למועמד"
      description="מנוע הניתוח דורג את המועמדים החיצוניים הזמינים לפי ציון התאמה."
      secondaryAction={{ label: 'סגור', onClick: onClose }}
    >
      <div className="max-h-[70vh] overflow-y-auto space-y-5">
        <section>
          <div className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">התאמות זמינות</div>
          {q.isLoading ? (
            <LoadingSkeleton rows={6} />
          ) : q.isError ? (
            <ErrorState description={(q.error as Error).message} onRetry={() => q.refetch()} />
          ) : !allMatches.length ? (
            <EmptyState title="לא נמצאו התאמות זמינות" description="ייתכן שאין מועמדים חיצוניים פעילים העומדים בקריטריונים." />
          ) : (
            <ul className="space-y-2">
              {allMatches.slice(0, visibleCount).map((m: FindMatchItem) => (
                <li key={m.externalCandidateId} className="rounded-md border border-border bg-white p-3 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="min-w-0 sm:flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="text-sm font-medium truncate">
                        {`${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || 'ללא שם'}
                      </div>
                      <Badge tone={m.matchType === 'safe' ? 'success' : m.matchType === 'balanced' ? 'brand' : 'warning'}>
                        {label('matchType', m.matchType)}
                      </Badge>
                      {m.sectorGroup && <Badge tone="neutral">{label('sectorGroup', m.sectorGroup)}</Badge>}
                      <InsightFitBadge fit={fitFor(internalCandidateId, m.externalCandidateId)} />
                    </div>
                    <div className="text-xs text-ink-muted mt-1 flex items-center gap-2 flex-wrap">
                      {m.city && <span>{m.city}</span>}
                      {m.age && <span className="num">גיל {m.age}</span>}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 sm:justify-end">
                    <div className="text-end shrink-0">
                      <div className="text-lg font-semibold num text-brand-700">{m.matchScore}</div>
                      <div className="text-xs text-ink-muted num">ביטחון {m.confidenceScore}</div>
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <Link to={`/candidates/external/${m.externalCandidateId}`} className="text-xs text-brand-700 hover:underline text-center">פרופיל</Link>
                      <Button size="sm" variant="secondary" loading={createSuggestion.isPending} onClick={() => createSuggestion.mutate(m.externalCandidateId)}>
                        צור הצעה
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
              {visibleCount < allMatches.length && (
                <li className="pt-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full"
                    onClick={() => setVisibleCount((c) => c + CHUNK)}
                  >
                    {`הצג עוד (${allMatches.length - visibleCount})`}
                  </Button>
                </li>
              )}
            </ul>
          )}
        </section>

        <section>
          <div className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">מועמדים חסומים / לא זמינים להתאמה</div>
          <BlockedCandidatesList internalCandidateId={internalCandidateId} enabled={open} />
        </section>
      </div>
    </Dialog>
  );
}

function ProfileSections({ c }: { c: Awaited<ReturnType<typeof internalCandidatesApi.get>>['data'] }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><h3 className="text-sm font-semibold">סגנון דתי ואישי</h3></CardHeader>
        <CardBody className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <Field label="מצב אישי" value={label('personalStatus', c.personalStatus)} />
          <Field label="ילדים" value={String(c.numberOfChildren)} />
          <Field label="שלב חיים" value={label('lifeStage', c.lifeStage)} />
          <Field label="מוכנות לנישואין" value={label('readinessForMarriage', c.readinessForMarriage)} />
          <Field label="גוון דתי" value={label('lifestyleTone', c.lifestyleTone)} />
          <Field label="סגנון הלכתי" value={label('religiousStyle', c.religiousStyle)} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><h3 className="text-sm font-semibold">לימודים ועבודה</h3></CardHeader>
        <CardBody className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <Field label="כיוון לימודים/עבודה" value={label('studyWorkDirection', c.studyWorkDirection)} />
        </CardBody>
      </Card>

      {(c.about || c.whatSeeking) && (
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">טקסט חופשי</h3></CardHeader>
          <CardBody className="space-y-3">
            {c.about && (<div><div className="text-xs text-ink-muted mb-1">על עצמו</div><p className="text-sm leading-relaxed">{c.about}</p></div>)}
            {c.whatSeeking && (<div><div className="text-xs text-ink-muted mb-1">מה מחפש</div><p className="text-sm leading-relaxed">{c.whatSeeking}</p></div>)}
          </CardBody>
        </Card>
      )}

      {c.openness && (
        <Card>
          <CardHeader><h3 className="text-sm font-semibold">פתיחות</h3></CardHeader>
          <CardBody className="flex flex-wrap gap-2">
            {c.openness.openToOtherSectors && <Badge tone="info">פתוח למגזרים אחרים</Badge>}
            {c.openness.openToConverts && <Badge tone="info">פתוח לגרים</Badge>}
            {c.openness.openToDivorced && <Badge tone="info">פתוח לגרושים</Badge>}
            {c.openness.openToWithChildren && <Badge tone="info">פתוח למועמד עם ילדים</Badge>}
            {c.openness.openToAgeDifference && <Badge tone="info">פערי גיל</Badge>}
            {c.openness.openToLongDistance && <Badge tone="info">למרחק</Badge>}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

// Server attaches resolved names (attachCandidateNames) — fall back to
// the id tail only for legacy rows that predate the enrichment.
type SuggestionTableRow = MatchSuggestion & { externalName?: string };

function SuggestionsTable({ items, loading }: { items: SuggestionTableRow[]; loading: boolean }) {
  if (loading) return <LoadingSkeleton rows={5} />;
  if (items.length === 0) return <EmptyState title="אין הצעות שידוך" description="ניתן להריץ ניתוח התאמות או ליצור הצעה ידנית." />;
  return (
    <Card>
      <Table>
        <THead>
          <Tr>
            <Th>מועמד/ת</Th><Th>סוג</Th><Th>ציון</Th><Th>ביטחון</Th><Th>סטטוס</Th><Th></Th>
          </Tr>
        </THead>
        <TBody>
          {items.map((m) => (
            <Tr key={m._id}>
              <Td>
                <Link
                  to={`/candidates/external/${m.externalCandidateId}`}
                  className="text-sm font-medium text-ink hover:underline"
                >
                  {m.externalName ?? m.externalCandidateId.slice(-8)}
                </Link>
              </Td>
              <Td><Badge tone={m.matchType === 'safe' ? 'success' : m.matchType === 'balanced' ? 'brand' : 'warning'}>{label('matchType', m.matchType)}</Badge></Td>
              <Td className="num font-semibold">{m.matchScore}</Td>
              <Td className="num">{m.confidenceScore}</Td>
              <Td><Badge tone={m.isDeferred ? 'warning' : 'neutral'}>{label('matchStatus', m.status)}</Badge></Td>
              <Td className="text-end">
                <Link to={`/matches/${m._id}`} className="text-xs text-brand-700 hover:underline">פתח</Link>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

function LinkedConversations({ items, loading }: { items: Conversation[]; loading: boolean }) {
  if (loading) return <LoadingSkeleton rows={3} />;
  if (items.length === 0) return <EmptyState title="אין שיחות מקושרות" description="שיחות WhatsApp משויכות יופיעו כאן." />;
  return (
    <Card>
      <ul className="divide-y divide-border">
        {items.map((c) => (
          <li key={c._id} className="px-5 py-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">{c.participantName ?? 'משתתף'}</div>
              <div className="text-xs text-ink-muted">
                <Badge tone={c.channelRole === 'profiles_source' ? 'info' : 'purple'}>{label('channelRole', c.channelRole)}</Badge>
                <span className="ms-2">{c.accountDisplayName}</span>
              </div>
            </div>
            <Link to={`/chats?c=${c._id}`} className="text-xs text-brand-700 hover:underline">פתח</Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function buildInternalCardText(c: InternalCandidate): string {
  const age = c.dateOfBirth
    ? Math.floor((Date.now() - new Date(c.dateOfBirth).getTime()) / 3.15576e10)
    : undefined;
  const lines = [
    `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
    [age ? `גיל ${age}` : '', c.city ?? ''].filter(Boolean).join(' · '),
    c.sectorGroup ? label('sectorGroup', c.sectorGroup) : '',
    c.about ? `\n${c.about}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="text-sm text-ink mt-0.5">{value}</div>
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="text-ink font-medium num">{value}</span>
    </div>
  );
}

