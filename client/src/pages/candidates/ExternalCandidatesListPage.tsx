import { useQuery } from '@tanstack/react-query';
import { Search, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Avatar, Badge, Button, Card, Input, Select, TBody, THead, Table, Td, Th, Tr } from '@/components/ui/primitives';
import { EmptyState, ErrorState, RowSkeleton } from '@/components/states/states';
import { externalCandidatesApi } from '@/services/api/candidates';
import { ExternalCandidateDrawer } from './ExternalCandidateDrawer';
import { ExternalCandidateForm } from '@/features/forms/ExternalCandidateForm';
import { Pagination } from '@/components/ui/Pagination';
import { label } from '@/utils/labels';

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
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-ink-faint" />
            <Input className="ps-9" placeholder="חיפוש" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select value={sectorGroup} onChange={(e) => setSectorGroup(e.target.value)}>
            <option value="">כל המגזרים</option>
            {SECTORS.map((s) => <option key={s} value={s}>{label('sectorGroup', s)}</option>)}
          </Select>
          <Select value={availabilityStatus} onChange={(e) => setAvailabilityStatus(e.target.value)}>
            <option value="">כל הזמינות</option>
            {AVAILABILITIES.map((a) => <option key={a} value={a}>{label('availabilityStatus', a)}</option>)}
          </Select>
        </div>

        {list.isError ? (
          <ErrorState description={(list.error as Error).message} onRetry={() => list.refetch()} />
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
