// ═══════════════════════════════════════════════════════════
// Dashboard (Phase 4 rebuild).
//
// The old multi-widget grid has been replaced with a single
// prioritized action queue backed by /api/dashboard/queue.
// On top sits a daily brief — a KPI strip fed by
// /api/insights/summary, so all numbers come from one honest
// aggregation instead of per-card list queries.
//
// Realtime: the SSE subscription from Phase 3 is mounted here
// so the queue updates live when inbound messages, review
// items or match transitions arrive.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { Heart, Inbox, Reply, Send, UserPlus, Users2 } from 'lucide-react';
import { useState } from 'react';
import { KpiCard } from '@/components/domain/KpiCard';
import { insightsApi } from '@/services/api/insights';
import { dashboardApi, type DashboardRowType } from '@/services/api/dashboard';
import { ActionQueue } from '@/features/dashboard/ActionQueue';
import { OwnershipFilter, type OwnershipScope } from '@/features/ownership/OwnershipFilter';
import { useRealtimeEvents } from '@/features/realtime/useRealtimeEvents';
import { Card, Select } from '@/components/ui/primitives';

export function DashboardPage() {
  // Keep realtime fresh on the dashboard itself — Phase 3 mounted
  // this only on /chats. The hook invalidates ['dashboard','queue']
  // among its targeted keys so the queue reflects live changes.
  useRealtimeEvents(true);

  const [ownership, setOwnership] = useState<OwnershipScope>('mine');
  const [type, setType] = useState<DashboardRowType | ''>('');

  // ── Daily brief (single insights aggregation) ──
  const summary = useQuery({
    queryKey: ['insights', 'summary'],
    queryFn: () => insightsApi.summary(),
    staleTime: 60_000,
  });
  const c = summary.data?.data?.counters;

  const queue = useQuery({
    queryKey: ['dashboard', 'queue', ownership, type],
    queryFn: () => dashboardApi.queue({
      ownership,
      type: type || undefined,
      limit: 100,
    }),
    // Realtime invalidates this on meaningful backend events;
    // the interval is just a safety net if SSE drops.
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">תור פעולות</h2>
        <p className="text-sm text-ink-muted">
          הדבר הבא שצריך לטפל בו — ממוין לפי דחיפות וגיל הפריט.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard
          label="פעילים"
          value={c?.activeInternals ?? '—'}
          hint={c ? `+ ${c.activeExternals} במאגר הכללי` : undefined}
          icon={<Users2 className="h-5 w-5" />}
        />
        <KpiCard
          label="בהיכרות"
          value={c?.datingInternals ?? '—'}
          icon={<Heart className="h-5 w-5" />}
          tone="good"
        />
        <KpiCard
          label="שוגרו השבוע"
          value={c?.sentThisWeek ?? '—'}
          hint="7 ימים אחרונים"
          icon={<Send className="h-5 w-5" />}
        />
        <KpiCard
          label="תגובות השבוע"
          value={c?.responsesThisWeek ?? '—'}
          hint={c ? `${c.acceptedThisWeek} חיוביות` : undefined}
          icon={<Reply className="h-5 w-5" />}
          tone={c && c.acceptedThisWeek > 0 ? 'good' : 'neutral'}
        />
        <KpiCard
          label="חדשים השבוע"
          value={c?.newCandidatesThisWeek ?? '—'}
          hint="מועמדים שנוספו"
          icon={<UserPlus className="h-5 w-5" />}
        />
        <KpiCard
          label="ממתין לסקירה"
          value={c?.needsReview ?? '—'}
          icon={<Inbox className="h-5 w-5" />}
          tone={c && c.needsReview > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <Card className="p-3 flex items-center gap-3 flex-wrap">
        <OwnershipFilter value={ownership} onChange={setOwnership} />
        <Select className="w-full sm:w-auto" value={type} onChange={(e) => setType(e.target.value as DashboardRowType | '')}>
          <option value="">כל הקטגוריות</option>
          <option value="new_response">תגובה חדשה</option>
          <option value="awaiting_response">ממתין לתגובה</option>
          <option value="overdue_task">משימה באיחור</option>
          <option value="needs_review">דורש סקירה</option>
          <option value="high_potential_draft">הצעה בציון גבוה</option>
          <option value="deferred_recheck">מושהה — לבדוק שוב</option>
        </Select>
        <span className="text-xs text-ink-faint ms-auto">
          {queue.data ? `${queue.data.data.length} פריטים` : ''}
        </span>
      </Card>

      <ActionQueue
        rows={queue.data?.data}
        isLoading={queue.isLoading}
        isError={queue.isError}
        onRetry={() => queue.refetch()}
      />
    </div>
  );
}
