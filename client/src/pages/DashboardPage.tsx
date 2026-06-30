// ═══════════════════════════════════════════════════════════
// Dashboard (Phase 4 rebuild).
//
// The old multi-widget grid has been replaced with a single
// prioritized action queue backed by /api/dashboard/queue.
// A compact KPI strip stays on top — lightweight, honest,
// derived from existing list endpoints.
//
// Realtime: the SSE subscription from Phase 3 is mounted here
// so the queue updates live when inbound messages, review
// items or match transitions arrive.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { Heart, Send, Users2 } from 'lucide-react';
import { useState } from 'react';
import { KpiCard } from '@/components/domain/KpiCard';
import { matchesApi } from '@/services/api/matches';
import { internalCandidatesApi } from '@/services/api/candidates';
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

  // ── KPIs (lightweight, derived from existing endpoints) ──
  const activeInternals = useQuery({
    queryKey: ['internals', 'active-count'],
    queryFn: () => internalCandidatesApi.list({ status: 'active', limit: 1 }),
    staleTime: 60_000,
  });
  const datingInternals = useQuery({
    queryKey: ['internals', 'dating-count'],
    queryFn: () => internalCandidatesApi.list({ status: 'dating', limit: 1 }),
    staleTime: 60_000,
  });
  const sentThisWeek = useQuery({
    queryKey: ['matches', 'sent-week'],
    queryFn: () => matchesApi.list({
      // "sent this week" is approximated by status; an explicit
      // sentAt>=7d filter would need a new API surface and is
      // deferred to Phase 5 if insights surfaces it.
      status: 'sent_side_a',
      limit: 1,
    }),
    staleTime: 60_000,
  });

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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KpiCard label="פעילים" value={activeInternals.data?.meta?.total ?? '—'} icon={<Users2 className="h-5 w-5" />} />
        <KpiCard label="בהיכרות" value={datingInternals.data?.meta?.total ?? '—'} icon={<Heart className="h-5 w-5" />} tone="good" />
        <KpiCard label="הצעות פעילות ששוגרו" value={sentThisWeek.data?.meta?.total ?? '—'} icon={<Send className="h-5 w-5" />} />
      </div>

      <Card className="p-3 flex items-center gap-3 flex-wrap">
        <OwnershipFilter value={ownership} onChange={setOwnership} />
        <Select className="w-full sm:w-auto" value={type} onChange={(e) => setType(e.target.value as DashboardRowType | '')}>
          <option value="">כל הקטגוריות</option>
          <option value="new_response">תגובה חדשה</option>
          <option value="inbound_action">שיחה דורשת תשומת לב</option>
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
