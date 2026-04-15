import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, Mail, MapPin, Phone, Search, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Avatar, Badge, Button, Card, CardBody, CardHeader, Divider, TBody, THead, Table, Td, Th, Tr, Tabs } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { internalCandidatesApi } from '@/services/api/candidates';
import { matchesApi, type FindMatchItem } from '@/services/api/matches';
import { aiApi } from '@/services/api/ai';
import { ReadinessIndicator } from '@/components/domain/ReadinessIndicator';
import { ClosedBanner, DatingStatusBanner, DeferredSuggestionsBanner } from '@/components/domain/banners';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { label } from '@/utils/labels';
import type { MatchSuggestion, Conversation, InternalCandidate } from '@/types/domain';

export function InternalCandidateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [findOpen, setFindOpen] = useState(false);
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

  const summarize = useMutation({
    mutationFn: async (doc: InternalCandidate) => aiApi.summarizeCandidate({ candidate: brief(doc) }),
    onSuccess: (r) => {
      const d = r.data as { summary?: string; communicationStyle?: string; warnings?: string[] };
      toast.info('סיכום AI', [d.summary, d.communicationStyle, ...(d.warnings ?? [])].filter(Boolean).join('\n\n'));
    },
    onError: (err) => toast.error('סיכום נכשל', (err as Error).message),
  });

  if (candidate.isLoading) return <div className="p-6"><LoadingSkeleton rows={8} /></div>;
  if (candidate.isError) return <ErrorState description={(candidate.error as Error).message} onRetry={() => candidate.refetch()} />;
  if (!candidate.data) return null;

  const c = candidate.data.data;
  const isDating = c.status === 'dating';
  const isClosed = c.status === 'closed';

  return (
    <div className="space-y-4">
      {/* Sticky header */}
      <Card className="sticky top-0 z-10">
        <CardBody className="flex items-center gap-4">
          <Avatar name={`${c.firstName} ${c.lastName}`} size={56} src={c.photoApproved ? c.photoUrl : undefined} />
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
              <span className="inline-flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />{new Date(c.dateOfBirth).toLocaleDateString('he-IL')}</span>
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
            <Button variant="secondary">עריכה</Button>
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
                id: 'suggestions',
                label: 'הצעות שידוך',
                badge: <Badge tone="brand">{suggestions.data?.data.length ?? 0}</Badge>,
                content: <SuggestionsTable items={suggestions.data?.data ?? []} loading={suggestions.isLoading} />,
              },
              {
                id: 'conversations',
                label: 'שיחות',
                badge: <Badge tone="neutral">{conversations.data?.data.length ?? 0}</Badge>,
                content: <LinkedConversations items={conversations.data?.data ?? []} loading={conversations.isLoading} />,
              },
              {
                id: 'history',
                label: 'היסטוריה',
                content: <EmptyState title="יומן פעילות" description="בקרוב: יומן מלא של פעולות, הצעות שנשלחו, שינויי סטטוס." />,
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
              <MetricRow label="עודכן לאחרונה" value={c.lastActionAt ? new Date(c.lastActionAt).toLocaleDateString('he-IL') : '—'} />
              <MetricRow label="אומת לאחרונה" value={c.lastVerifiedAt ? new Date(c.lastVerifiedAt).toLocaleDateString('he-IL') : '—'} />
            </CardBody>
          </Card>
        </aside>
      </div>

      <FindMatchesDialog
        open={findOpen}
        onClose={() => setFindOpen(false)}
        internalCandidateId={c._id}
      />
    </div>
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
  const q = useQuery({
    queryKey: ['find-matches', internalCandidateId, open],
    queryFn: () => matchesApi.findForInternal(internalCandidateId, { limit: 25 }),
    enabled: open,
  });

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
      <div className="max-h-[60vh] overflow-y-auto">
        {q.isLoading ? (
          <LoadingSkeleton rows={6} />
        ) : q.isError ? (
          <ErrorState description={(q.error as Error).message} onRetry={() => q.refetch()} />
        ) : !q.data?.data.length ? (
          <EmptyState title="לא נמצאו התאמות זמינות" description="ייתכן שאין מועמדים חיצוניים פעילים העומדים בקריטריונים." />
        ) : (
          <ul className="space-y-2">
            {q.data.data.map((m: FindMatchItem) => (
              <li key={m.externalCandidateId} className="rounded-md border border-border bg-white p-3 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-sm font-medium truncate">
                      {`${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || 'ללא שם'}
                    </div>
                    <Badge tone={m.matchType === 'safe' ? 'success' : m.matchType === 'balanced' ? 'brand' : 'warning'}>
                      {label('matchType', m.matchType)}
                    </Badge>
                    {m.sectorGroup && <Badge tone="neutral">{label('sectorGroup', m.sectorGroup)}</Badge>}
                  </div>
                  <div className="text-xs text-ink-muted mt-1 flex items-center gap-2 flex-wrap">
                    {m.city && <span>{m.city}</span>}
                    {m.age && <span className="num">גיל {m.age}</span>}
                  </div>
                </div>
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function ProfileSections({ c }: { c: Awaited<ReturnType<typeof internalCandidatesApi.get>>['data'] }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><h3 className="text-sm font-semibold">סגנון דתי ואישי</h3></CardHeader>
        <CardBody className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
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
        <CardBody className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
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

function SuggestionsTable({ items, loading }: { items: MatchSuggestion[]; loading: boolean }) {
  if (loading) return <LoadingSkeleton rows={5} />;
  if (items.length === 0) return <EmptyState title="אין הצעות שידוך" description="ניתן להריץ ניתוח התאמות או ליצור הצעה ידנית." />;
  return (
    <Card>
      <Table>
        <THead>
          <Tr>
            <Th>חיצוני</Th><Th>סוג</Th><Th>ציון</Th><Th>ביטחון</Th><Th>סטטוס</Th><Th></Th>
          </Tr>
        </THead>
        <TBody>
          {items.map((m) => (
            <Tr key={m._id}>
              <Td className="font-mono text-xs">{m.externalCandidateId.slice(-8)}</Td>
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

function brief(c: InternalCandidate) {
  return {
    id: c._id, firstName: c.firstName, lastName: c.lastName, gender: c.gender,
    city: c.city, sectorGroup: c.sectorGroup, subSector: c.subSector,
    lifestyleTone: c.lifestyleTone, personalStatus: c.personalStatus,
    lifeStage: c.lifeStage, studyWorkDirection: c.studyWorkDirection,
    about: c.about, whatSeeking: c.whatSeeking,
    profileCompletion: c.profileCompletion,
    missingCriticalFields: c.missingCriticalFields,
  };
}
