// ═══════════════════════════════════════════════════════════
// CandidateInsightTab — "מה למדנו"
//
// Shows the learned preference profile the learning agent built from
// the candidate's suggestion history: narrative summary, patterns the
// candidate responded well to, patterns to avoid, and actionable
// direction for the next suggestions. "רענן למידה" rebuilds the
// insight from the latest history on demand.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, Lightbulb, RefreshCw, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, Divider } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { internalCandidatesApi, type CandidateInsight } from '@/services/api/candidates';
import { formatDateTime } from '@/utils/format';

export function CandidateInsightTab({ candidateId }: { candidateId: string }) {
  const qc = useQueryClient();
  const insight = useQuery({
    queryKey: ['internal', candidateId, 'insight'],
    queryFn: () => internalCandidatesApi.insight(candidateId),
    enabled: !!candidateId,
  });

  const rebuild = useMutation({
    mutationFn: () => internalCandidatesApi.rebuildInsight(candidateId),
    onSuccess: (r) => {
      const d = r.data;
      if (d && 'rebuilt' in d && d.rebuilt === false) {
        toast.info('אין עדיין מה ללמוד', 'למועמד אין היסטוריית הצעות עם סיבות סטטוס.');
      } else {
        toast.success('הלמידה עודכנה', 'התובנות נבנו מחדש מההיסטוריה העדכנית');
      }
      qc.invalidateQueries({ queryKey: ['internal', candidateId, 'insight'] });
    },
    onError: (e) => toast.error('רענון הלמידה נכשל', (e as Error).message),
  });

  if (insight.isLoading) return <LoadingSkeleton rows={5} />;
  if (insight.isError) {
    return <ErrorState description={(insight.error as Error).message} onRetry={() => insight.refetch()} />;
  }

  const data = insight.data?.data;
  if (!data) {
    return (
      <EmptyState
        icon={<Brain className="h-10 w-10 text-ink-faint" />}
        title="עדיין אין תובנות למידה"
        description="עדיין אין מספיק היסטוריה כדי ללמוד את המועמד — סמן סיבות בשינויי סטטוס כדי להאכיל את הלמידה"
        action={
          <Button
            variant="secondary"
            loading={rebuild.isPending}
            onClick={() => rebuild.mutate()}
            leftIcon={<RefreshCw className="h-4 w-4" />}
          >
            רענן למידה
          </Button>
        }
      />
    );
  }

  return <InsightBody insight={data} onRebuild={() => rebuild.mutate()} rebuilding={rebuild.isPending} />;
}

function InsightBody({ insight, onRebuild, rebuilding }: {
  insight: CandidateInsight;
  onRebuild: () => void;
  rebuilding: boolean;
}) {
  return (
    <Card>
      <CardHeader
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={rebuilding}
            onClick={onRebuild}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            רענן למידה
          </Button>
        }
      >
        <h3 className="text-sm font-semibold inline-flex items-center gap-1.5">
          <Brain className="h-4 w-4 text-brand-700" />
          מה למדנו על המועמד
        </h3>
      </CardHeader>
      <CardBody className="space-y-4 text-sm">
        <p className="leading-relaxed text-ink">{insight.summary}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SignalList
            tone="pos"
            title="מגיב טוב ל..."
            icon={<ThumbsUp className="h-3.5 w-3.5" />}
            items={insight.positiveSignals}
          />
          <SignalList
            tone="neg"
            title="להימנע מ..."
            icon={<ThumbsDown className="h-3.5 w-3.5" />}
            items={insight.negativeSignals}
          />
        </div>

        {insight.guidance.length > 0 && (
          <div className="rounded-md bg-bg-subtle p-3">
            <div className="text-xs font-medium text-brand-700 uppercase tracking-wide mb-1.5 inline-flex items-center gap-1.5">
              <Lightbulb className="h-3.5 w-3.5" />
              כיוון להצעות הבאות
            </div>
            <ul className="list-disc ps-4 space-y-1">
              {insight.guidance.map((g, i) => <li key={i}>{g}</li>)}
            </ul>
          </div>
        )}

        <Divider />
        <div className="text-[11px] text-ink-faint">
          מבוסס על {insight.basedOnSuggestions} הצעות · ביטחון {Math.round(insight.confidence * 100)}%
          {insight.updatedAt ? ` · עודכן ${formatDateTime(insight.updatedAt)}` : ''}
        </div>
      </CardBody>
    </Card>
  );
}

function SignalList({ title, items, tone, icon }: {
  title: string;
  items: string[];
  tone: 'pos' | 'neg';
  icon: React.ReactNode;
}) {
  const titleColor = tone === 'pos' ? 'text-emerald-700' : 'text-red-700';
  const dotColor = tone === 'pos' ? 'bg-emerald-500' : 'bg-red-500';
  return (
    <div className="rounded-md border border-border p-3">
      <div className={`text-xs font-semibold mb-1.5 inline-flex items-center gap-1.5 ${titleColor}`}>
        {icon}
        {title}
      </div>
      {items.length ? (
        <ul className="space-y-1">
          {items.map((t, i) => (
            <li key={i} className="text-sm text-ink flex gap-1.5 items-start">
              <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`} />
              <span className="min-w-0">{t}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-xs text-ink-faint">—</div>
      )}
    </div>
  );
}
