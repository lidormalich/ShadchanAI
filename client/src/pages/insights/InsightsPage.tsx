// ═══════════════════════════════════════════════════════════
// Insights (Phase 5 — honest-only rebuild).
//
// Every number on this page is backed by /api/insights/summary,
// which is aggregated directly from real collections. There is
// no fake chart, no placeholder shadchan performance section.
// When we have real per-shadchan analytics, they can be added
// here without having to remove anything fake first.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckSquare, Heart, Inbox, Send, Users2, UserCheck } from 'lucide-react';
import { KpiCard } from '@/components/domain/KpiCard';
import { Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { LoadingSkeleton } from '@/components/states/states';
import { insightsApi } from '@/services/api/insights';

export function InsightsPage() {
  const q = useQuery({
    queryKey: ['insights', 'summary'],
    queryFn: () => insightsApi.summary(),
    staleTime: 60_000,
  });

  const c = q.data?.data.counters;
  const funnel = q.data?.data.funnel ?? [];
  const funnelMax = Math.max(1, ...funnel.map((f) => f.count));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">תובנות תפעוליות</h2>
        <p className="text-sm text-ink-muted">נתונים אמיתיים בלבד — מצטברים מהמערכת החיה.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard label="פעילים" value={c?.activeInternals ?? '—'} icon={<Users2 className="h-5 w-5" />} />
        <KpiCard label="בהיכרות" value={c?.datingInternals ?? '—'} icon={<Heart className="h-5 w-5" />} tone="good" />
        <KpiCard label="חיצוניים פעילים" value={c?.activeExternals ?? '—'} icon={<UserCheck className="h-5 w-5" />} />
        <KpiCard label="נשלחו השבוע" value={c?.sentThisWeek ?? '—'} icon={<Send className="h-5 w-5" />} />
        <KpiCard label="משימות פתוחות" value={c?.openTasks ?? '—'} icon={<CheckSquare className="h-5 w-5" />} />
        <KpiCard label="דורש סקירה" value={c?.needsReview ?? '—'} icon={<Inbox className="h-5 w-5" />} tone={c?.needsReview ? 'bad' : undefined} />
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold inline-flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> משפך הצעות
          </h3>
        </CardHeader>
        <CardBody>
          {q.isLoading ? (
            <LoadingSkeleton rows={5} />
          ) : (
            <div className="space-y-2">
              {funnel.map((f) => (
                <div key={f.key} className="flex items-center gap-3">
                  <div className="w-24 text-xs text-ink-muted">{f.label}</div>
                  <div className="flex-1 h-2 bg-bg-subtle rounded-full overflow-hidden">
                    <div
                      className="bg-brand h-full rounded-full transition-all"
                      style={{ width: `${Math.round((f.count / funnelMax) * 100)}%` }}
                    />
                  </div>
                  <div className="w-10 text-xs num text-end text-ink">{f.count}</div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
