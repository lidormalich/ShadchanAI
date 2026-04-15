import { useQuery } from '@tanstack/react-query';
import { LayoutGrid, Rows3, Search, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { internalCandidatesApi } from '@/services/api/candidates';
import { Avatar, Badge, Button, Card, CardBody, Input, Select, TBody, THead, Table, Td, Th, Tr } from '@/components/ui/primitives';
import { EmptyState, ErrorState, RowSkeleton } from '@/components/states/states';
import { InternalCandidateForm } from '@/features/forms/InternalCandidateForm';
import { Pagination } from '@/components/ui/Pagination';
import { label } from '@/utils/labels';
import type { InternalCandidate } from '@/types/domain';

const SECTORS = ['dati_leumi', 'haredi', 'dati', 'masorti', 'hardal', 'torani'] as const;
const STATUSES = ['active', 'paused', 'dating', 'closed'] as const;

type ViewMode = 'table' | 'cards';

export function InternalCandidatesListPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('active');
  const [sectorGroup, setSectorGroup] = useState<string>('');
  const [gender, setGender] = useState<string>('');
  const [view, setView] = useState<ViewMode>('table');
  const [formOpen, setFormOpen] = useState(false);
  const [page, setPage] = useState(1);
  const limit = 25;

  const query = useQuery({
    queryKey: ['internals', { search, status, sectorGroup, gender, page }],
    queryFn: () => internalCandidatesApi.list({
      search: search || undefined,
      status: status || undefined,
      sectorGroup: sectorGroup || undefined,
      gender: gender || undefined,
      page,
      limit,
    }),
  });

  // Reset to page 1 when filters change
  const filterKey = `${search}|${status}|${sectorGroup}|${gender}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    if (page !== 1) setPage(1);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">מועמדים פנימיים</h2>
          <p className="text-sm text-ink-muted">ניהול המועמדים של השדכנות</p>
        </div>
        <Button leftIcon={<UserPlus className="h-4 w-4" />} onClick={() => setFormOpen(true)}>הוסף מועמד</Button>
      </div>

      <Card>
        <div className="p-4 border-b border-border flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-ink-faint" />
            <Input
              className="ps-9"
              placeholder="חיפוש לפי שם"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">כל הסטטוסים</option>
            {STATUSES.map((s) => <option key={s} value={s}>{label('candidateStatus', s)}</option>)}
          </Select>
          <Select value={sectorGroup} onChange={(e) => setSectorGroup(e.target.value)}>
            <option value="">כל המגזרים</option>
            {SECTORS.map((s) => <option key={s} value={s}>{label('sectorGroup', s)}</option>)}
          </Select>
          <Select value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="">בנים ובנות</option>
            <option value="male">בנים</option>
            <option value="female">בנות</option>
          </Select>
          <div className="ms-auto flex gap-1 p-0.5 rounded-md bg-bg-subtle border border-border">
            <button
              onClick={() => setView('table')}
              className={`p-1.5 rounded ${view === 'table' ? 'bg-white shadow-sm' : 'text-ink-muted'}`}
              aria-label="טבלה"
            >
              <Rows3 className="h-4 w-4" />
            </button>
            <button
              onClick={() => setView('cards')}
              className={`p-1.5 rounded ${view === 'cards' ? 'bg-white shadow-sm' : 'text-ink-muted'}`}
              aria-label="כרטיסים"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          </div>
        </div>

        {query.isError ? (
          <ErrorState description={(query.error as Error).message} onRetry={() => query.refetch()} />
        ) : view === 'table' ? (
          <Table>
            <THead>
              <Tr>
                <Th>שם</Th>
                <Th>מגזר</Th>
                <Th>עיר</Th>
                <Th>גיל</Th>
                <Th>סטטוס</Th>
                <Th>מוכנות</Th>
                <Th></Th>
              </Tr>
            </THead>
            <TBody>
              {query.isLoading ? (
                <RowSkeleton cols={7} />
              ) : query.data?.data.length ? (
                query.data.data.map((c) => <CandidateRow key={c._id} c={c} />)
              ) : (
                <Tr>
                  <Td colSpan={7}>
                    <EmptyState title="לא נמצאו מועמדים" description="נסה להתאים את הסינונים או להוסיף מועמד חדש." />
                  </Td>
                </Tr>
              )}
            </TBody>
          </Table>
        ) : (
          <CardBody>
            {query.isLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="skeleton h-40 rounded-xl" />
                ))}
              </div>
            ) : query.data?.data.length ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {query.data.data.map((c) => <CandidateGridCard key={c._id} c={c} />)}
              </div>
            ) : (
              <EmptyState title="לא נמצאו מועמדים" />
            )}
          </CardBody>
        )}
        {query.data && (
          <Pagination
            page={page}
            totalPages={query.data.meta?.totalPages ?? 1}
            total={query.data.meta?.total}
            onChange={setPage}
          />
        )}
      </Card>
      <InternalCandidateForm open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function ageFromDob(dob: string): number {
  const d = new Date(dob);
  const diff = Date.now() - d.getTime();
  return Math.abs(new Date(diff).getUTCFullYear() - 1970);
}

function CandidateRow({ c }: { c: InternalCandidate }) {
  return (
    <Tr>
      <Td>
        <Link to={`/candidates/internal/${c._id}`} className="flex items-center gap-3 hover:text-brand-700">
          <Avatar name={`${c.firstName} ${c.lastName}`} size={32} src={c.photoApproved ? c.photoUrl : undefined} />
          <div className="min-w-0">
            <div className="font-medium truncate">{c.firstName} {c.lastName}</div>
            <div className="text-xs text-ink-faint">{c.hebrewName ?? ''}</div>
          </div>
        </Link>
      </Td>
      <Td>
        <div className="text-xs">
          <div>{label('sectorGroup', c.sectorGroup)}</div>
          {c.subSector && <div className="text-ink-faint">{label('subSector', c.subSector)}</div>}
        </div>
      </Td>
      <Td className="text-sm text-ink-muted">{c.city ?? '—'}</Td>
      <Td className="text-sm num">{ageFromDob(c.dateOfBirth)}</Td>
      <Td><StatusBadge status={c.status} /></Td>
      <Td><CompletionBar value={c.profileCompletion} blocked={c.sendReadinessBlockers.length > 0} /></Td>
      <Td className="text-end">
        <Link to={`/candidates/internal/${c._id}`} className="text-xs text-brand-700 hover:underline">פרופיל</Link>
      </Td>
    </Tr>
  );
}

function CandidateGridCard({ c }: { c: InternalCandidate }) {
  return (
    <Link to={`/candidates/internal/${c._id}`} className="block">
      <Card className="p-4 hover:shadow-rise transition-shadow">
        <div className="flex items-start gap-3">
          <Avatar name={`${c.firstName} ${c.lastName}`} size={44} src={c.photoApproved ? c.photoUrl : undefined} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold truncate">{c.firstName} {c.lastName}</div>
            <div className="text-xs text-ink-muted truncate">{c.city ?? ''} · גיל {ageFromDob(c.dateOfBirth)}</div>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <StatusBadge status={c.status} />
              <Badge tone="neutral">{label('sectorGroup', c.sectorGroup)}</Badge>
            </div>
          </div>
        </div>
        <div className="mt-3">
          <CompletionBar value={c.profileCompletion} blocked={c.sendReadinessBlockers.length > 0} />
        </div>
      </Card>
    </Link>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === 'active' ? 'success' : status === 'dating' ? 'purple' : status === 'closed' ? 'neutral' : 'warning';
  return <Badge tone={tone as 'success' | 'purple' | 'neutral' | 'warning'}>{label('candidateStatus', status)}</Badge>;
}

function CompletionBar({ value, blocked }: { value: number; blocked: boolean }) {
  const color = blocked ? 'bg-warning' : value >= 80 ? 'bg-success' : value >= 60 ? 'bg-brand' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-bg-subtle rounded-full overflow-hidden">
        <div className={color + ' h-full rounded-full'} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-ink-muted num w-10 text-end">{value}%</span>
    </div>
  );
}
