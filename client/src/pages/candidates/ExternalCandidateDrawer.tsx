import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Calendar, Pencil, MapPin, Share2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Avatar, Badge, Button, Card, CardBody, Tabs } from '@/components/ui/primitives';
import { LoadingSkeleton } from '@/components/states/states';
import { externalCandidatesApi } from '@/services/api/candidates';
import { ExternalCandidateForm } from '@/features/forms/ExternalCandidateForm';
import { CreateSuggestionDialog } from '@/features/matching/CreateSuggestionDialog';
import { StaleBanner } from '@/components/domain/banners';
import { label } from '@/utils/labels';
import { NotesRail } from '@/features/notes/NotesRail';
import { TasksRail } from '@/features/tasks/TasksRail';
import { EntityTimeline } from '@/features/history/EntityTimeline';
import { OwnerChip } from '@/features/users/OwnerChip';
import { PhotoTab } from '@/features/candidates/PhotoTab';
import type { ExternalCandidate } from '@/types/domain';

/** Shareable card text for an external candidate (used by the photo tab's copy). */
export function buildExternalCardText(c: ExternalCandidate): string {
  const lines = [
    `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'מועמד',
    [c.age ? `גיל ${c.age}` : '', c.city ?? ''].filter(Boolean).join(' · '),
    c.sectorGroup ? label('sectorGroup', c.sectorGroup) : '',
    c.about ? `\n${c.about}` : '',
    c.whatSeeking ? `\nמחפש/ת: ${c.whatSeeking}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function ExternalCandidateDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const open = id !== null;
  const [editOpen, setEditOpen] = useState(false);
  const [createSuggestionOpen, setCreateSuggestionOpen] = useState(false);
  const ext = useQuery({
    queryKey: ['external', id],
    queryFn: () => externalCandidatesApi.get(id!),
    enabled: !!id,
  });
  const matching = useQuery({
    queryKey: ['external', id, 'matching'],
    queryFn: () => externalCandidatesApi.matchingInternals(id!, { limit: 10 }),
    enabled: !!id,
  });

  const c = ext.data?.data;

  return (
    <>
    <Drawer
      open={open}
      onClose={onClose}
      title={c ? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'מועמד חיצוני' : 'טוען…'}
      subtitle={c ? `מקור: ${c.sourceName ?? label('sourceType', c.sourceType)} · עודכן ${c.lastSourceUpdateAt ? new Date(c.lastSourceUpdateAt).toLocaleDateString('he-IL') : 'לא ידוע'}` : undefined}
      width="xl"
      footer={
        c && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Badge tone={c.availabilityStatus === 'available' ? 'success' : c.availabilityStatus === 'dating' ? 'purple' : 'warning'}>
                {label('availabilityStatus', c.availabilityStatus)}
              </Badge>
              {c.staleAt && <Badge tone="warning">ישן</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" leftIcon={<Pencil className="h-4 w-4" />} onClick={() => setEditOpen(true)}>עריכה</Button>
              <Button leftIcon={<Share2 className="h-4 w-4" />} onClick={() => setCreateSuggestionOpen(true)}>צור הצעת שידוך</Button>
            </div>
          </div>
        )
      }
    >
      {ext.isLoading ? (
        <div className="p-5"><LoadingSkeleton rows={6} /></div>
      ) : !c ? (
        <div className="p-5 text-sm text-ink-muted">לא נמצא מועמד.</div>
      ) : (
        <div className="p-5 space-y-4">
          {/* Header */}
          <div className="flex items-center gap-4">
            {/* The operator always sees the photo. sharePhoto gates only the
                OUTBOUND share card (the "תצוגה מקדימה לשיתוף" tab), not this
                internal workspace view. */}
            <Avatar name={`${c.firstName ?? ''} ${c.lastName ?? ''}`} size={64} src={c.photoUrl} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {c.sectorGroup && <Badge tone="neutral">{label('sectorGroup', c.sectorGroup)}</Badge>}
                {c.subSector && <Badge tone="neutral">{label('subSector', c.subSector)}</Badge>}
                {c.lifestyleTone && <Badge tone="info">{label('lifestyleTone', c.lifestyleTone)}</Badge>}
                {c.personalStatus && <Badge tone="neutral">{label('personalStatus', c.personalStatus)}</Badge>}
              </div>
              <div className="mt-1 text-sm text-ink-muted flex items-center gap-3 flex-wrap">
                {c.city && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{c.city}</span>}
                {c.age && <span className="inline-flex items-center gap-1 num"><Calendar className="h-3.5 w-3.5" />{c.age}</span>}
                {c.ageReliability?.ageConfidence && <span className="text-xs">דיוק גיל: {label('ageConfidence', c.ageReliability.ageConfidence)}</span>}
                <OwnerChip userId={c.ownerUserId} />
              </div>
            </div>
          </div>

          {c.staleAt && <StaleBanner />}

          <Tabs
            tabs={[
              { id: 'profile', label: 'פרופיל מלא', content: <FullProfile c={c} /> },
              { id: 'photo', label: 'תמונה', content: <PhotoTab type="external" candidateId={c._id} name={`${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'מועמד'} photoUrl={c.photoUrl} cardText={buildExternalCardText(c)} /> },
              { id: 'match', label: 'ניתוח התאמה', badge: <Badge tone="brand">{matching.data?.data.length ?? 0}</Badge>, content: <MatchingInternals items={matching.data?.data ?? []} loading={matching.isLoading} /> },
              { id: 'share', label: 'תצוגה מקדימה לשיתוף', content: <ShareCardPreview c={c} /> },
              { id: 'history', label: 'היסטוריה', content: <EntityTimeline entityType="external_candidate" entityId={c._id} title="יומן פעילות" asCard={false} /> },
              { id: 'tasks', label: 'משימות', content: <TasksRail related={{ type: 'external_candidate', id: c._id }} /> },
              { id: 'notes', label: 'הערות', content: <NotesRail entityType="external_candidate" entityId={c._id} /> },
            ]}
          />
        </div>
      )}
    </Drawer>
    <ExternalCandidateForm open={editOpen} onClose={() => setEditOpen(false)} initial={c} />
    <CreateSuggestionDialog open={createSuggestionOpen} onClose={() => setCreateSuggestionOpen(false)} initialExternal={c} />
    </>
  );
}

export function FullProfile({ c }: { c: ExternalCandidate }) {
  return (
    <div className="space-y-3">
      <Card>
        <CardBody className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <F label="מגזר" v={label('sectorGroup', c.sectorGroup)} />
          <F label="תת-מגזר" v={label('subSector', c.subSector)} />
          <F label="גוון דתי" v={label('lifestyleTone', c.lifestyleTone)} />
          <F label="שלב חיים" v={label('lifeStage', c.lifeStage)} />
          <F label="כיוון לימודים/עבודה" v={label('studyWorkDirection', c.studyWorkDirection)} />
          <F label="גובה" v={c.height ? `${c.height} ס״מ` : '—'} />
        </CardBody>
      </Card>
      {c.about && <Card><CardBody><div className="text-xs text-ink-muted mb-1">על עצמו</div><p className="text-sm leading-relaxed">{c.about}</p></CardBody></Card>}
      {c.whatSeeking && <Card><CardBody><div className="text-xs text-ink-muted mb-1">מה מחפש</div><p className="text-sm leading-relaxed">{c.whatSeeking}</p></CardBody></Card>}
      {c.sourceMatchmakerName && (
        <Card><CardBody className="text-sm"><span className="text-ink-muted">שדכן מקור: </span>{c.sourceMatchmakerName}</CardBody></Card>
      )}
    </div>
  );
}

function MatchingInternals({ items, loading }: { items: unknown[]; loading: boolean }) {
  if (loading) return <LoadingSkeleton rows={4} />;
  if (!items.length) return (
    <Card>
      <CardBody className="text-sm text-ink-muted flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 text-warning" />
        לא נמצאו התאמות פנימיות דרך מנוע הניתוח. ייתכן שהצדדים אינם עומדים ברף, או שהפרופיל חסר נתונים.
      </CardBody>
    </Card>
  );
  return (
    <ul className="space-y-2">
      {items.map((raw, i) => {
        const r = raw as { internalCandidate?: { id?: string; firstName?: string; lastName?: string }; matchScore?: number; confidenceScore?: number; matchType?: string };
        return (
          <li key={i} className="rounded-md border border-border bg-white p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">
                {r.internalCandidate?.firstName ?? 'פנימי'} {r.internalCandidate?.lastName ?? ''}
              </div>
              <div className="text-xs text-ink-muted">{label('matchType', r.matchType)}</div>
            </div>
            <div className="text-end">
              <div className="text-lg font-semibold num text-brand-700">{r.matchScore}</div>
              <div className="text-xs text-ink-muted num">ב {r.confidenceScore}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ShareCardPreview({ c }: { c: ExternalCandidate }) {
  const { shareCard } = c;
  return (
    <div className="space-y-3">
      <Card className="bg-brand-50 border-brand-100">
        <CardBody>
          <div className="flex items-center gap-2 text-xs text-brand-700 mb-3">
            <Sparkles className="h-4 w-4" />
            תצוגה מקדימה לכרטיס השיתוף (מה הצד השני יראה)
          </div>
          <div className="bg-white rounded-lg p-4 border border-border">
            <div className="flex items-center gap-3">
              {shareCard.photoMode && shareCard.photoMode !== 'none' ? (
                <Avatar name={`${c.firstName ?? ''} ${c.lastName ?? ''}`} size={56} src={c.photoUrl} className={shareCard.photoMode === 'blurred' ? 'blur-sm' : ''} />
              ) : (
                <Avatar name={`${c.firstName ?? ''}`} size={56} />
              )}
              <div className="min-w-0">
                <div className="text-base font-semibold">{shareCard.title ?? `${c.firstName ?? ''} ${c.lastName ?? ''}`}</div>
                {c.age && <div className="text-xs text-ink-muted">גיל {c.age} · {c.city ?? ''}</div>}
              </div>
            </div>
            {shareCard.summary && <p className="text-sm leading-relaxed mt-3">{shareCard.summary}</p>}
            {shareCard.visibleFields && shareCard.visibleFields.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {shareCard.visibleFields.map((f) => <Badge key={f} tone="neutral">{f}</Badge>)}
              </div>
            )}
          </div>
          <div className="mt-3 text-xs text-ink-muted">
            {shareCard.approvedForShare ? '✓ מאושר לשיתוף' : '⚠ לא מאושר לשיתוף'}
            {shareCard.lastReviewedAt && ` · נבחן לאחרונה ${new Date(shareCard.lastReviewedAt).toLocaleDateString('he-IL')}`}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function F({ label, v }: { label: string; v: string }) {
  return (
    <div>
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="text-sm text-ink mt-0.5">{v}</div>
    </div>
  );
}
