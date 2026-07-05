import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardList, Search, UserPlus } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from '@/components/ui/Toast';
import { Avatar, Badge, Button, Card, CardBody, Input, Select, TBody, THead, Table, Td, Th, Tr } from '@/components/ui/primitives';
import { EmptyState, ErrorState, RowSkeleton } from '@/components/states/states';
import { externalCandidatesApi } from '@/services/api/candidates';
import { ExternalCandidateDrawer } from './ExternalCandidateDrawer';
import { ExternalCandidateForm } from '@/features/forms/ExternalCandidateForm';
import { Pagination } from '@/components/ui/Pagination';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { GenderBadge } from '@/components/domain/GenderBadge';
import { label } from '@/utils/labels';
import type { ExternalCandidate } from '@/types/domain';

const SECTORS = ['dati_leumi', 'haredi', 'dati', 'masorti', 'hardal', 'torani'] as const;
const AVAILABILITIES = ['available', 'dating', 'unavailable', 'unknown'] as const;

// What the needs-details tab flags as "חסר" on each card. Gender is the
// entry criterion for the tab; the rest give the operator the full
// fill-in checklist at a glance.
function missingFields(c: ExternalCandidate): string[] {
  const missing: string[] = [];
  if (!c.gender) missing.push('מין');
  if (!`${c.firstName ?? ''}${c.lastName ?? ''}`.trim()) missing.push('שם');
  if (c.age == null) missing.push('גיל');
  if (!c.city) missing.push('עיר');
  if (!c.sectorGroup) missing.push('מגזר');
  if (!c.personalStatus) missing.push('סטטוס אישי');
  if (c.availabilityStatus === 'unknown') missing.push('זמינות');
  return missing;
}

export function ExternalCandidatesListPage() {
  // Deep links from the insights "מגדר חסר" KPI arrive as ?gender=missing.
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [sectorGroup, setSectorGroup] = useState('');
  // '' = all, 'male', 'female', 'missing' (no gender set).
  const initialGender = (() => {
    const g = searchParams.get('gender');
    return g === 'male' || g === 'female' || g === 'missing' ? g : '';
  })();
  // When deep-linked to a data-quality filter, start with no availability
  // narrowing so every flagged candidate is visible.
  const [availabilityStatus, setAvailabilityStatus] = useState(initialGender ? '' : 'available');
  const [gender, setGender] = useState(initialGender);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [page, setPage] = useState(1);
  // 'all' — the regular list; 'needsDetails' — gender unknown, not yet
  // marked "מולא" (deep link: ?tab=needsDetails).
  const [tab, setTab] = useState<'all' | 'needsDetails'>(
    searchParams.get('tab') === 'needsDetails' ? 'needsDetails' : 'all',
  );
  const needsDetails = tab === 'needsDetails';
  const limit = 25;
  // Tables don't fit a phone — show cards on mobile.
  const isMobile = useIsMobile();
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ['externals', { search, sectorGroup, availabilityStatus, gender, page, tab }],
    queryFn: () => externalCandidatesApi.list({
      search: search || undefined,
      sectorGroup: sectorGroup || undefined,
      // The needs-details tab must show everything that needs filling,
      // regardless of availability/gender narrowing.
      availabilityStatus: needsDetails ? undefined : (availabilityStatus || undefined),
      gender: !needsDetails && (gender === 'male' || gender === 'female') ? gender : undefined,
      missingGender: !needsDetails && gender === 'missing' ? true : undefined,
      needsDetails: needsDetails ? true : undefined,
      page,
      limit,
    }),
  });

  // Badge count for the tab — cheap: 1-item page, we only read meta.total.
  const needsDetailsCount = useQuery({
    queryKey: ['externals', 'needs-details-count'],
    queryFn: () => externalCandidatesApi.list({ needsDetails: true, limit: 1 }),
  });

  const markFilled = useMutation({
    mutationFn: (id: string) => externalCandidatesApi.setDetailsCompleted(id),
    onSuccess: () => {
      toast.success('סומן שמולא — ירד מרשימת ההשלמה');
      void qc.invalidateQueries({ queryKey: ['externals'] });
    },
    onError: (e) => toast.error('הסימון נכשל', (e as Error).message),
  });

  const filterKey = `${search}|${sectorGroup}|${availabilityStatus}|${gender}|${tab}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    if (page !== 1) setPage(1);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">מועמדים חיצוניים</h2>
          <p className="text-sm text-ink-muted">פרופילים ממקורות חיצוניים (קבוצות WhatsApp, שדכנים אחרים, אתרים)</p>
        </div>
        <Button leftIcon={<UserPlus className="h-4 w-4" />} onClick={() => setFormOpen(true)}>הוסף חיצוני</Button>
      </div>

      <Card>
        <div className="px-4 pt-3 border-b border-border flex items-center gap-1">
          <button
            className={`px-3 py-2 text-sm rounded-t-lg border-b-2 -mb-px transition-colors ${
              tab === 'all'
                ? 'border-brand-600 text-brand-700 font-medium'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
            onClick={() => setTab('all')}
          >
            כל המועמדים
          </button>
          <button
            className={`px-3 py-2 text-sm rounded-t-lg border-b-2 -mb-px transition-colors inline-flex items-center gap-1.5 ${
              tab === 'needsDetails'
                ? 'border-brand-600 text-brand-700 font-medium'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
            onClick={() => setTab('needsDetails')}
          >
            <ClipboardList className="h-4 w-4" />
            נדרש למלא פרטים
            {(needsDetailsCount.data?.meta?.total ?? 0) > 0 && (
              <Badge tone="warning">{needsDetailsCount.data?.meta?.total}</Badge>
            )}
          </button>
        </div>
        <div className="p-4 border-b border-border flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-0 sm:min-w-[240px] w-full sm:w-auto">
            <Search className="absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-ink-faint" />
            <Input className="ps-9" placeholder="חיפוש" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select className="w-full sm:w-auto" value={sectorGroup} onChange={(e) => setSectorGroup(e.target.value)}>
            <option value="">כל המגזרים</option>
            {SECTORS.map((s) => <option key={s} value={s}>{label('sectorGroup', s)}</option>)}
          </Select>
          {!needsDetails && (
            <>
              <Select className="w-full sm:w-auto" value={availabilityStatus} onChange={(e) => setAvailabilityStatus(e.target.value)}>
                <option value="">כל הזמינות</option>
                {AVAILABILITIES.map((a) => <option key={a} value={a}>{label('availabilityStatus', a)}</option>)}
              </Select>
              <Select className="w-full sm:w-auto" value={gender} onChange={(e) => setGender(e.target.value)}>
                <option value="">בנים ובנות</option>
                <option value="male">בנים</option>
                <option value="female">בנות</option>
                <option value="missing">חסר מגדר</option>
              </Select>
            </>
          )}
        </div>

        {list.isError ? (
          <ErrorState description={(list.error as Error).message} onRetry={() => list.refetch()} />
        ) : isMobile ? (
          <CardBody>
            {list.isLoading ? (
              <div className="grid grid-cols-1 gap-4">
                {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-32 rounded-xl" />)}
              </div>
            ) : list.data?.data.length ? (
              <div className="grid grid-cols-1 gap-4">
                {list.data.data.map((c) => (
                  <ExternalCard
                    key={c._id}
                    c={c}
                    onOpen={() => setDrawerId(c._id)}
                    needsDetails={needsDetails}
                    onMarkFilled={() => markFilled.mutate(c._id)}
                    markPending={markFilled.isPending}
                  />
                ))}
              </div>
            ) : (
              <EmptyState title={needsDetails ? 'אין מועמדים שממתינים להשלמת פרטים 🎉' : 'לא נמצאו פרופילים חיצוניים'} />
            )}
          </CardBody>
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>שם / מקור</Th>
                <Th>מין</Th>
                <Th>מגזר</Th>
                <Th>עיר</Th>
                <Th>גיל</Th>
                {needsDetails ? <Th>חסר להשלמה</Th> : <Th>זמינות</Th>}
                {!needsDetails && <Th>כרטיס שיתוף</Th>}
                <Th></Th>
              </Tr>
            </THead>
            <TBody>
              {list.isLoading ? <RowSkeleton cols={8} /> :
                list.data?.data.length ? list.data.data.map((c) => (
                  <Tr key={c._id} className="cursor-pointer" onClick={() => setDrawerId(c._id)}>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Avatar name={`${c.firstName ?? ''} ${c.lastName ?? ''}`} size={32} src={c.photoUrl} />
                        <div className="min-w-0">
                          <div className="font-medium truncate">{`${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'ללא שם'}</div>
                          <div className="text-xs text-ink-faint">{c.sourceName ?? label('sourceType', c.sourceType)}</div>
                        </div>
                      </div>
                    </Td>
                    <Td><GenderBadge gender={c.gender} /></Td>
                    <Td className="text-xs">
                      <div>{label('sectorGroup', c.sectorGroup)}</div>
                      <div className="text-ink-faint">{c.subSector ? label('subSector', c.subSector) : ''}</div>
                    </Td>
                    <Td className="text-sm text-ink-muted">{c.city ?? '—'}</Td>
                    <Td className="text-sm"><span className="num">{c.age ?? '—'}</span></Td>
                    {needsDetails ? (
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {missingFields(c).map((f) => <Badge key={f} tone="warning">{f}</Badge>)}
                        </div>
                      </Td>
                    ) : (
                      <Td>
                        <Badge tone={c.availabilityStatus === 'available' ? 'success' : c.availabilityStatus === 'dating' ? 'purple' : 'warning'}>
                          {label('availabilityStatus', c.availabilityStatus)}
                        </Badge>
                      </Td>
                    )}
                    {!needsDetails && (
                      <Td className="text-xs">
                        {c.shareCard?.approvedForShare ? <Badge tone="success">כרטיס מאושר</Badge> : <Badge tone="neutral">לא מאושר</Badge>}
                      </Td>
                    )}
                    <Td className="text-end">
                      <div className="flex items-center justify-end gap-2">
                        {needsDetails && (
                          <Button
                            size="sm"
                            variant="secondary"
                            leftIcon={<CheckCircle2 className="h-3.5 w-3.5" />}
                            onClick={(e) => { e.stopPropagation(); markFilled.mutate(c._id); }}
                            loading={markFilled.isPending && markFilled.variables === c._id}
                          >
                            מולא
                          </Button>
                        )}
                        <button className="text-xs text-brand-700 hover:underline" onClick={(e) => { e.stopPropagation(); setDrawerId(c._id); }}>
                          פתח
                        </button>
                      </div>
                    </Td>
                  </Tr>
                )) : (
                  <Tr><Td colSpan={8}><EmptyState title={needsDetails ? 'אין מועמדים שממתינים להשלמת פרטים 🎉' : 'לא נמצאו פרופילים חיצוניים'} /></Td></Tr>
                )
              }
            </TBody>
          </Table>
        )}
        {list.data && (
          <Pagination
            page={page}
            totalPages={list.data.meta?.totalPages ?? 1}
            total={list.data.meta?.total}
            onChange={setPage}
          />
        )}
      </Card>

      <ExternalCandidateDrawer id={drawerId} onClose={() => setDrawerId(null)} />
      <ExternalCandidateForm open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

const ExternalCard = React.memo(function ExternalCard({
  c,
  onOpen,
  needsDetails = false,
  onMarkFilled,
  markPending = false,
}: {
  c: ExternalCandidate;
  onOpen: () => void;
  needsDetails?: boolean;
  onMarkFilled?: () => void;
  markPending?: boolean;
}) {
  const fullName = useMemo(
    () => `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'ללא שם',
    [c.firstName, c.lastName],
  );
  return (
    <Card className="p-4 hover:shadow-rise transition-shadow cursor-pointer" onClick={onOpen}>
      <div className="flex items-start gap-3">
        <Avatar name={fullName} size={44} src={c.photoUrl} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{fullName}</div>
          <div className="text-xs text-ink-faint truncate">{c.sourceName ?? label('sourceType', c.sourceType)}</div>
          <div className="text-xs text-ink-muted truncate mt-0.5">
            {c.city ?? '—'}{c.age ? ` · גיל ${c.age}` : ''}
          </div>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <GenderBadge gender={c.gender} />
            <Badge tone={c.availabilityStatus === 'available' ? 'success' : c.availabilityStatus === 'dating' ? 'purple' : 'warning'}>
              {label('availabilityStatus', c.availabilityStatus)}
            </Badge>
            <Badge tone="neutral">{label('sectorGroup', c.sectorGroup)}</Badge>
            {c.shareCard?.approvedForShare && <Badge tone="success">כרטיס מאושר</Badge>}
          </div>
          {needsDetails && (
            <>
              <div className="mt-2 flex items-center gap-1 flex-wrap">
                <span className="text-[11px] text-ink-muted">חסר:</span>
                {missingFields(c).map((f) => <Badge key={f} tone="warning">{f}</Badge>)}
              </div>
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<CheckCircle2 className="h-3.5 w-3.5" />}
                  onClick={(e) => { e.stopPropagation(); onMarkFilled?.(); }}
                  loading={markPending}
                >
                  מולא
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}, (prev, next) =>
  prev.c._id === next.c._id &&
  prev.needsDetails === next.needsDetails &&
  prev.markPending === next.markPending);
