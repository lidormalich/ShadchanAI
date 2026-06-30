import { useQuery } from '@tanstack/react-query';
import { Filter } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Select } from '@/components/ui/primitives';
import { ErrorState, LoadingSkeleton } from '@/components/states/states';
import { MatchCard } from '@/components/domain/MatchCard';
import { matchesApi } from '@/services/api/matches';
import { OwnershipFilter } from '@/features/ownership/OwnershipFilter';
import { CreateSuggestionDialog } from '@/features/matching/CreateSuggestionDialog';
import { MatchScanBar } from '@/features/matching/MatchScanBar';
import type { MatchSuggestion } from '@/types/domain';

interface Stage {
  id: string;
  label: string;
  statuses: string[];
  tone: 'neutral' | 'brand' | 'success' | 'warning' | 'purple';
}

const STAGES: Stage[] = [
  { id: 'new',       label: 'חדשות', statuses: ['draft', 'pending_approval'], tone: 'neutral' },
  { id: 'approved',  label: 'אושרו', statuses: ['approved'], tone: 'brand' },
  { id: 'sent',      label: 'נשלחו', statuses: ['sent_side_a', 'sent_side_b', 'sent_both'], tone: 'brand' },
  { id: 'accepted',  label: 'תגובה חיובית', statuses: ['accepted_side_a', 'accepted_side_b', 'accepted_both'], tone: 'success' },
  { id: 'dating',    label: 'בהיכרות', statuses: ['dating'], tone: 'purple' },
  { id: 'deferred',  label: 'מושהות', statuses: ['deferred'], tone: 'warning' },
];

// status -> stageId lookup, built once for O(1) grouping.
const STATUS_TO_STAGE: Record<string, string> = Object.fromEntries(
  STAGES.flatMap((s) => s.statuses.map((status) => [status, s.id])),
);

export function MatchesPipelinePage() {
  const [matchType, setMatchType] = useState('');
  const [minScore, setMinScore] = useState('');
  const [ownership, setOwnership] = useState<'mine' | 'team' | 'all'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // Topbar "new action" menu links here with ?new=1 to open the dialog.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setCreateOpen(true);
      searchParams.delete('new');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const query = useQuery({
    queryKey: ['matches', { matchType, minScore, ownership }],
    queryFn: () => matchesApi.list({
      matchType: matchType || undefined,
      minScore: minScore ? Number(minScore) : undefined,
      ownership,
      limit: 200,
    }),
  });

  const byStage = useMemo(() => {
    const grouped: Record<string, MatchSuggestion[]> = Object.fromEntries(STAGES.map((s) => [s.id, []]));
    for (const m of query.data?.data ?? []) {
      const stageId = STATUS_TO_STAGE[m.status];
      if (stageId) grouped[stageId]!.push(m);
    }
    return grouped;
  }, [query.data?.data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">הצעות שידוך</h2>
          <p className="text-sm text-ink-muted">מצב הצנרת הכולל של הצעות השידוך</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>צור הצעה ידנית</Button>
      </div>

      <CreateSuggestionDialog open={createOpen} onClose={() => setCreateOpen(false)} />

      <MatchScanBar />

      <Card className="p-4 flex flex-wrap items-center gap-3">
        <Filter className="h-4 w-4 text-ink-faint" />
        <Select className="w-full sm:w-auto" value={matchType} onChange={(e) => setMatchType(e.target.value)}>
          <option value="">כל הסוגים</option>
          <option value="safe">בטוח</option>
          <option value="balanced">מאוזן</option>
          <option value="creative">יצירתי</option>
          <option value="risky">מסוכן</option>
        </Select>
        <Select className="w-full sm:w-auto" value={minScore} onChange={(e) => setMinScore(e.target.value)}>
          <option value="">כל הציונים</option>
          <option value="80">80+</option>
          <option value="60">60+</option>
          <option value="40">40+</option>
        </Select>
        <OwnershipFilter value={ownership} onChange={setOwnership} />
      </Card>

      {query.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : query.isError ? (
        <ErrorState description={(query.error as Error).message} onRetry={() => query.refetch()} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6 gap-4">
          {STAGES.map((s) => (
            <StageColumn key={s.id} stage={s} items={byStage[s.id] ?? []} />
          ))}
        </div>
      )}
    </div>
  );
}

function StageColumn({ stage, items }: { stage: Stage; items: MatchSuggestion[] }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between mb-2 px-1">
        <h3 className="text-sm font-semibold text-ink">{stage.label}</h3>
        <Badge tone={stage.tone}>{items.length}</Badge>
      </div>
      <div className="bg-bg-subtle rounded-xl p-2 min-h-[200px] space-y-2">
        {items.length === 0 ? (
          <div className="text-xs text-ink-faint py-6 text-center">ריק</div>
        ) : (
          items.map((m) => <MatchCard key={m._id} match={m} compact />)
        )}
      </div>
    </div>
  );
}
