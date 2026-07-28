// ═══════════════════════════════════════════════════════════
// SmartMatchesPage — "הצעה חכמה" from the main navigation: the
// smart inbox for one internal candidate, three intelligence layers
// side by side —
//   1. הצעה חכמה   — vector similarity (what the TEXTS say)
//   2. לפי ההיכרות — revealed-preference ranking (what the CANDIDATE
//                    chose in their swipe sessions + AI summary)
//   3. מה למדנו    — the CandidateInsight the AI distilled from ALL
//                    feedback (suggestions + swipes)
// The selected candidate is kept in the URL (?candidate=<id>) so the
// view is deep-linkable and survives refresh.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { Brain, Heart, Sparkles } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { Avatar, Card, CardBody, Tabs } from '@/components/ui/primitives';
import { CandidatePicker } from '@/components/ui/CandidatePicker';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { internalCandidatesApi } from '@/services/api/candidates';
import { SemanticMatchesSection } from '@/features/compatibility/CompatibilityWorkspace';
import { DiscoveryRankingSection } from '@/features/discovery/DiscoveryRankingSection';
import { CandidateInsightTab } from '@/features/candidates/CandidateInsightTab';
import { internalToOption } from '@/features/candidates/candidateOptions';

export function SmartMatchesPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('candidate') ?? '';

  // limit must respect the server's PAGINATION.MAX_LIMIT (100); the
  // pagination schema's sort field is `sort`, not `sortBy`.
  const candidates = useQuery({
    queryKey: ['internal-candidates', 'smart-matches-picker'],
    queryFn: () => internalCandidatesApi.list({ status: 'active', limit: 100, sort: 'firstName', order: 'asc' }),
  });

  const items = candidates.data?.data ?? [];
  const selected = items.find((c) => c._id === selectedId);
  const selectedName = selected
    ? `${selected.firstName ?? ''} ${selected.lastName ?? ''}`.trim()
    : '';

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex items-center gap-3 flex-wrap">
          <Sparkles className="h-5 w-5 text-purple-600" />
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold">הצעה חכמה</h2>
            <div className="text-xs text-ink-muted">
              שלוש שכבות חוכמה למועמד/ת אחד/ת: דמיון טקסטים, מה שנחשף בהיכרות החכמה, ומה שה-AI למד — בחר מועמד/ת כדי להתחיל
            </div>
          </div>
          <CandidatePicker
            className="w-72"
            value={selectedId}
            onChange={(id) => setParams(id ? { candidate: id } : {}, { replace: true })}
            disabled={candidates.isLoading}
            options={items.map(internalToOption)}
          />
        </CardBody>
      </Card>

      {candidates.isLoading ? (
        <LoadingSkeleton rows={4} />
      ) : candidates.isError ? (
        <ErrorState
          description={(candidates.error as Error).message}
          onRetry={() => candidates.refetch()}
        />
      ) : !selectedId ? (
        <Card className="p-6">
          <EmptyState
            title="לא נבחר מועמד"
            description="בחר מועמד/ת פנימי/ת מהרשימה למעלה כדי לראות מי מתאים לו/לה וקטורית."
          />
        </Card>
      ) : (
        <>
          <Card>
            <CardBody className="flex items-center gap-3">
              <Avatar
                name={selectedName}
                size={56}
                src={selected?.photoApproved ? selected.photoUrl : undefined}
              />
              <div className="min-w-0">
                {selectedName && <div className="font-semibold truncate">{selectedName}</div>}
                <Link
                  to={`/candidates/internal/${selectedId}`}
                  className="text-xs text-brand-700 hover:underline"
                >
                  מעבר לכרטיס המועמד/ת המלא (כולל לוח ההתאמה)
                </Link>
              </div>
            </CardBody>
          </Card>
          <Tabs
            tabs={[
              {
                id: 'semantic',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <Sparkles className="h-4 w-4" />
                    הצעה חכמה
                  </span>
                ),
                content: <SemanticMatchesSection internalCandidateId={selectedId} />,
              },
              {
                id: 'discovery',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <Heart className="h-4 w-4" />
                    לפי ההיכרות
                  </span>
                ),
                content: <DiscoveryRankingSection internalCandidateId={selectedId} />,
              },
              {
                id: 'insight',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <Brain className="h-4 w-4" />
                    מה למדנו
                  </span>
                ),
                content: <CandidateInsightTab candidateId={selectedId} />,
              },
            ]}
          />
        </>
      )}
    </div>
  );
}
