import { useQuery } from '@tanstack/react-query';
import { Search, UserPlus } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { Avatar, Badge, Button, Card, CardBody, Input, Select, TBody, THead, Table, Td, Th, Tr } from '@/components/ui/primitives';
import { EmptyState, ErrorState, RowSkeleton } from '@/components/states/states';
import { externalCandidatesApi } from '@/services/api/candidates';
import { ExternalCandidateDrawer } from './ExternalCandidateDrawer';
import { ExternalCandidateForm } from '@/features/forms/ExternalCandidateForm';
import { Pagination } from '@/components/ui/Pagination';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { label } from '@/utils/labels';
import type { ExternalCandidate } from '@/types/domain';

const SECTORS = ['dati_leumi', 'haredi', 'dati', 'masorti', 'hardal', 'torani'] as const;
const AVAILABILITIES = ['available', 'dating', 'unavailable', 'unknown'] as const;

export function ExternalCandidatesListPage() {
  const [search, setSearch] = useState('');
  const [sectorGroup, setSectorGroup] = useState('');
  const [availabilityStatus, setAvailabilityStatus] = useState('available');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [page, setPage] = useState(1);
  const limit = 25;
  // Tables don't fit a phone — show cards on mobile.
  const isMobile = useIsMobile();

  const list = useQuery({
    queryKey: ['externals', { search, sectorGroup, availabilityStatus, page }],
    queryFn: () => externalCandidatesApi.list({
      search: search || undefined,
      sectorGroup: sectorGroup || undefined,
      availabilityStatus: availabilityStatus || undefined,
      page,
      limit,
    }),
  });

  const filterKey = `${search}|${sectorGroup}|${availabilityStatus}`;
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
        <div className="p-4 border-b border-border flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-0 sm:min-w-[240px] w-full sm:w-auto">
            <Search className="absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-ink-faint" />
            <Input className="ps-9" placeholder="חיפוש" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select className="w-full sm:w-auto" value={sectorGroup} onChange={(e) => setSectorGroup(e.target.value)}>
            <option value="">כל המגזרים</option>
            {SECTORS.map((s) => <option key={s} value={s}>{label('sectorGroup', s)}</option>)}
          </Select>
          <Select className="w-full sm:w-auto" value={availabilityStatus} onChange={(e) => setAvailabilityStatus(e.target.value)}>
            <option value="">כל הזמינות</option>
            {AVAILABILITIES.map((a) => <option key={a} value={a}>{label('availabilityStatus', a)}</option>)}
          </Select>
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
                {list.data.data.map((c) => <ExternalCard key={c._id} c={c} onOpen={() => setDrawerId(c._id)} />)}
              </div>
            ) : (
              <EmptyState title="לא נמצאו פרופילים חיצוניים" />
            )}
          </CardBody>
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>שם / מקור</Th>
                <Th>מגזר</Th>
                <Th>עיר</Th>
                <Th>גיל</Th>
                <Th>זמינות</Th>
                <Th>מעמד</Th>
                <Th></Th>
              </Tr>
            </THead>
            <TBody>
              {list.isLoading ? <RowSkeleton cols={7} /> :
                list.data?.data.length ? list.data.data.map((c) => (
                  <Tr key={c._id} className="cursor-pointer" onClick={() => setDrawerId(c._id)}>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Avatar name={`${c.firstName ?? ''} ${c.lastName ?? ''}`} size={32} src={c.sharePhoto ? c.photoUrl : undefined} />
                        <div className="min-w-0">
                          <div className="font-medium truncate">{`${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'ללא שם'}</div>
                          <div className="text-xs text-ink-faint">{c.sourceName ?? label('sourceType', c.sourceType)}</div>
                        </div>
                      </div>
                    </Td>
                    <Td className="text-xs">
                      <div>{label('sectorGroup', c.sectorGroup)}</div>
                      <div className="text-ink-faint">{c.subSector ? label('subSector', c.subSector) : ''}</div>
                    </Td>
                    <Td className="text-sm text-ink-muted">{c.city ?? '—'}</Td>
                    <Td className="text-sm num">{c.age ?? '—'}</Td>
                    <Td>
                      <Badge tone={c.availabilityStatus === 'available' ? 'success' : c.availabilityStatus === 'dating' ? 'purple' : 'warning'}>
                        {label('availabilityStatus', c.availabilityStatus)}
                      </Badge>
                    </Td>
                    <Td className="text-xs">
                      {c.shareCard?.approvedForShare ? <Badge tone="success">כרטיס מאושר</Badge> : <Badge tone="neutral">לא מאושר</Badge>}
                    </Td>
                    <Td className="text-end">
                      <button className="text-xs text-brand-700 hover:underline" onClick={(e) => { e.stopPropagation(); setDrawerId(c._id); }}>
                        פתח
                      </button>
                    </Td>
                  </Tr>
                )) : (
                  <Tr><Td colSpan={7}><EmptyState title="לא נמצאו פרופילים חיצוניים" /></Td></Tr>
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

const ExternalCard = React.memo(function ExternalCard({ c, onOpen }: { c: ExternalCandidate; onOpen: () => void }) {
  const fullName = useMemo(
    () => `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'ללא שם',
    [c.firstName, c.lastName],
  );
  return (
    <Card className="p-4 hover:shadow-rise transition-shadow cursor-pointer" onClick={onOpen}>
      <div className="flex items-start gap-3">
        <Avatar name={fullName} size={44} src={c.sharePhoto ? c.photoUrl : undefined} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{fullName}</div>
          <div className="text-xs text-ink-faint truncate">{c.sourceName ?? label('sourceType', c.sourceType)}</div>
          <div className="text-xs text-ink-muted truncate mt-0.5">
            {c.city ?? '—'}{c.age ? ` · גיל ${c.age}` : ''}
          </div>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <Badge tone={c.availabilityStatus === 'available' ? 'success' : c.availabilityStatus === 'dating' ? 'purple' : 'warning'}>
              {label('availabilityStatus', c.availabilityStatus)}
            </Badge>
            <Badge tone="neutral">{label('sectorGroup', c.sectorGroup)}</Badge>
            {c.shareCard?.approvedForShare && <Badge tone="success">כרטיס מאושר</Badge>}
          </div>
        </div>
      </div>
    </Card>
  );
}, (prev, next) => prev.c._id === next.c._id);
