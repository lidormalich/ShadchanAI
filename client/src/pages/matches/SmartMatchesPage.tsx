// ═══════════════════════════════════════════════════════════
// SmartMatchesPage — "הצעה חכמה" from the main navigation.
//
// Pick an internal candidate → see the vector-similarity ranking
// (the same SemanticMatchesSection the compatibility board hosts,
// including the "סרוק עכשיו" embeddings backfill button).
// The selected candidate is kept in the URL (?candidate=<id>) so the
// view is deep-linkable and survives refresh.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, CardBody, Select } from '@/components/ui/primitives';
import { EmptyState, LoadingSkeleton } from '@/components/states/states';
import { internalCandidatesApi } from '@/services/api/candidates';
import { SemanticMatchesSection } from '@/features/compatibility/CompatibilityWorkspace';

export function SmartMatchesPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('candidate') ?? '';

  const candidates = useQuery({
    queryKey: ['internal-candidates', 'smart-matches-picker'],
    queryFn: () => internalCandidatesApi.list({ status: 'active', limit: 200, sortBy: 'firstName' }),
  });

  const items = candidates.data?.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex items-center gap-3 flex-wrap">
          <Sparkles className="h-5 w-5 text-purple-600" />
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold">הצעה חכמה</h2>
            <div className="text-xs text-ink-muted">
              דירוג מועמדים לפי דמיון וקטורי בטקסטים החופשיים — בחר מועמד/ת פנימי/ת כדי להתחיל
            </div>
          </div>
          <Select
            value={selectedId}
            onChange={(e) => {
              const id = e.target.value;
              setParams(id ? { candidate: id } : {}, { replace: true });
            }}
            className="w-64"
            disabled={candidates.isLoading}
          >
            <option value="">— בחר מועמד/ת —</option>
            {items.map((c) => (
              <option key={c._id} value={c._id}>
                {`${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || c._id}
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      {candidates.isLoading ? (
        <LoadingSkeleton rows={4} />
      ) : !selectedId ? (
        <Card className="p-6">
          <EmptyState
            title="לא נבחר מועמד"
            description="בחר מועמד/ת פנימי/ת מהרשימה למעלה כדי לראות מי מתאים לו/לה וקטורית."
          />
        </Card>
      ) : (
        <>
          <div className="text-xs text-ink-muted">
            <Link
              to={`/candidates/internal/${selectedId}`}
              className="text-brand-700 hover:underline"
            >
              מעבר לכרטיס המועמד/ת המלא (כולל לוח ההתאמה)
            </Link>
          </div>
          <SemanticMatchesSection internalCandidateId={selectedId} />
        </>
      )}
    </div>
  );
}
