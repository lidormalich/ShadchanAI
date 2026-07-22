import { useQuery } from '@tanstack/react-query';
import { Search, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { Badge, Button, Card, TBody, THead, Table, Td, Th, Tr } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { OwnershipFilter } from '@/features/ownership/OwnershipFilter';
import { matchesApi } from '@/services/api/matches';
import { isTerminalMatchStatus } from '@/utils/matchStatus';
import { label, matchTypeTone } from '@/utils/labels';
import type { MatchSuggestion } from '@/types/domain';

// One internal candidate + their suggestions, split into live (open) and
// finished (closed/expired/declined). Built by grouping the flat suggestion
// list client-side — the list endpoint already resolves internalName so no
// dedicated per-candidate call is needed.
interface CandidateGroup {
  id: string;
  name: string;
  open: MatchSuggestion[];
  closed: MatchSuggestion[];
}

function buildGroups(items: MatchSuggestion[]): CandidateGroup[] {
  const byId = new Map<string, CandidateGroup>();
  for (const m of items) {
    const id = String(m.internalCandidateId);
    let g = byId.get(id);
    if (!g) {
      g = { id, name: m.internalName || 'ללא שם', open: [], closed: [] };
      byId.set(id, g);
    }
    if (isTerminalMatchStatus(m.status)) g.closed.push(m);
    else g.open.push(m);
  }
  // Most live work first, then by total volume; stable name tiebreak.
  return [...byId.values()].sort(
    (a, b) =>
      b.open.length - a.open.length ||
      b.open.length + b.closed.length - (a.open.length + a.closed.length) ||
      a.name.localeCompare(b.name, 'he'),
  );
}

export function SuggestionsByCandidatePage() {
  const [ownership, setOwnership] = useState<'mine' | 'team' | 'all'>('all');
  const [search, setSearch] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('internal') ?? undefined;

  const query = useQuery({
    queryKey: ['matches', 'by-candidate', { ownership }],
    // Pull the whole book of suggestions once, group locally. 500 is the
    // list cap — see the note in the empty/full states if you ever exceed it.
    queryFn: () => matchesApi.list({ ownership, limit: 500 }),
  });

  const groups = useMemo(() => buildGroups(query.data?.data ?? []), [query.data?.data]);

  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q) return groups;
    return groups.filter((g) => g.name.includes(q));
  }, [groups, search]);

  // Resolve the selected candidate: explicit selection wins, else the first
  // in the (filtered) list so the detail pane is never empty when data exists.
  const selected =
    filtered.find((g) => g.id === selectedId) ?? groups.find((g) => g.id === selectedId) ?? filtered[0];

  const select = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('internal', id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">הצעות לפי מועמד</h2>
          <p className="text-sm text-ink-muted">בחר מועמד פנימי כדי לראות את כל ההצעות שלו — פתוחות וסגורות</p>
        </div>
        <OwnershipFilter value={ownership} onChange={setOwnership} />
      </div>

      {query.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : query.isError ? (
        <ErrorState description={(query.error as Error).message} onRetry={() => query.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState
          title="אין עדיין הצעות שידוך"
          description="כשייווצרו הצעות (ידנית או דרך סריקת ההתאמות), הן יופיעו כאן מקובצות לפי מועמד."
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 items-start">
          {/* Candidate rail */}
          <Card className="p-2">
            <div className="relative mb-2">
              <Search className="absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-ink-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="חפש מועמד…"
                className="w-full ps-9 pe-3 py-2 text-sm rounded-md border border-border bg-white text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </div>
            <ul className="space-y-0.5 max-h-[70vh] overflow-y-auto">
              {filtered.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => select(g.id)}
                    className={clsx(
                      'w-full flex items-center gap-2 px-3 py-2 rounded-md text-start transition-colors',
                      selected?.id === g.id ? 'bg-brand-50 text-brand-700' : 'hover:bg-bg-hover text-ink',
                    )}
                  >
                    <span className="flex-1 text-sm font-medium truncate">{g.name}</span>
                    {g.open.length > 0 && <Badge tone="brand">{g.open.length}</Badge>}
                    {g.closed.length > 0 && <Badge tone="neutral">{g.closed.length}</Badge>}
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="px-3 py-6 text-center text-sm text-ink-faint">אין מועמד תואם לחיפוש</li>
              )}
            </ul>
          </Card>

          {/* Detail: the selected candidate's suggestions */}
          <div className="space-y-4">
            {selected ? (
              <>
                <div className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-brand-700" />
                  <h3 className="text-base font-semibold">
                    <Link to={`/candidates/internal/${selected.id}`} className="hover:underline">
                      {selected.name}
                    </Link>
                  </h3>
                  <span className="text-sm text-ink-faint">
                    {selected.open.length} פתוחות · {selected.closed.length} סגורות
                  </span>
                </div>

                <SuggestionGroup title="פתוחות" tone="brand" items={selected.open} emptyText="אין הצעות פתוחות" />
                <SuggestionGroup title="סגורות" tone="neutral" items={selected.closed} emptyText="אין הצעות סגורות" />
              </>
            ) : (
              <EmptyState title="בחר מועמד" description="בחר מועמד מהרשימה כדי לראות את ההצעות שלו." />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SuggestionGroup({
  title,
  tone,
  items,
  emptyText,
}: {
  title: string;
  tone: 'brand' | 'neutral';
  items: MatchSuggestion[];
  emptyText: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        <Badge tone={items.length ? tone : 'neutral'}>{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-ink-faint py-4 px-1">{emptyText}</div>
      ) : (
        <Card>
          <Table>
            <THead>
              <Tr>
                <Th>מועמד/ת חיצוני/ת</Th>
                <Th>סוג</Th>
                <Th>ציון</Th>
                <Th>ביטחון</Th>
                <Th>סטטוס</Th>
                <Th></Th>
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
                  <Td>
                    <Badge tone={matchTypeTone(m.matchType)}>{label('matchType', m.matchType)}</Badge>
                  </Td>
                  <Td className="num font-semibold">{m.matchScore}</Td>
                  <Td className="num">{m.confidenceScore}</Td>
                  <Td>
                    <Badge tone={m.isDeferred ? 'warning' : 'neutral'}>{label('matchStatus', m.status)}</Badge>
                  </Td>
                  <Td className="text-end">
                    <Link to={`/matches/${m._id}`} className="text-xs text-brand-700 hover:underline">
                      פתח
                    </Link>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
