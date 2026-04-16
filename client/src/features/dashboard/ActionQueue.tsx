// ═══════════════════════════════════════════════════════════
// ActionQueue — unified operational queue for the dashboard.
// Renders DashboardRow[] from /api/dashboard/queue.
// Each row is a one-click entry point into the flow that
// completes the action; no dead read-only pages.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  MessageSquare,
  Reply,
  Send,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Button, Card } from '@/components/ui/primitives';
import { EmptyState, LoadingSkeleton } from '@/components/states/states';
import { OwnerChip } from '@/features/users/OwnerChip';
import { tasksApi } from '@/services/api/tasks';
import { toast } from '@/components/ui/Toast';
import type {
  DashboardRow,
  DashboardRowType,
  OverdueTaskRow,
} from '@/services/api/dashboard';

const CATEGORY: Record<DashboardRowType, {
  label: string;
  icon: React.ReactNode;
  tone: 'brand' | 'warning' | 'danger' | 'success' | 'info' | 'neutral' | 'purple';
}> = {
  new_response:         { label: 'תגובה חדשה',      icon: <Reply className="h-4 w-4" />,        tone: 'success' },
  inbound_action:       { label: 'שיחה דורשת תשומת לב', icon: <MessageSquare className="h-4 w-4" />, tone: 'brand' },
  awaiting_response:    { label: 'ממתין לתגובה',     icon: <Clock className="h-4 w-4" />,        tone: 'warning' },
  overdue_task:         { label: 'משימה באיחור',     icon: <AlertTriangle className="h-4 w-4" />, tone: 'danger' },
  needs_review:         { label: 'דורש סקירה',      icon: <Inbox className="h-4 w-4" />,        tone: 'info' },
  high_potential_draft: { label: 'הצעה בציון גבוה', icon: <Sparkles className="h-4 w-4" />,     tone: 'purple' },
  deferred_recheck:     { label: 'מושהה — לבדוק שוב', icon: <UserCheck className="h-4 w-4" />,   tone: 'neutral' },
};

export function ActionQueue({
  rows,
  isLoading,
  isError,
  onRetry,
}: {
  rows: DashboardRow[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  if (isError) {
    return (
      <Card className="p-5">
        <div className="text-sm text-danger">טעינת התור נכשלה.</div>
        <Button size="sm" variant="secondary" onClick={onRetry} className="mt-2">נסה שוב</Button>
      </Card>
    );
  }
  if (isLoading) {
    return <Card className="p-5"><LoadingSkeleton rows={6} /></Card>;
  }
  if (!rows || rows.length === 0) {
    return (
      <Card className="p-5">
        <EmptyState
          icon={<CheckCircle2 className="h-10 w-10 text-success" />}
          title="הכול נקי"
          description="אין פעולות פתוחות ברגע זה. הדשבורד יתעדכן אוטומטית עם הגעת פעילות חדשה."
        />
      </Card>
    );
  }
  return (
    <Card className="divide-y divide-border">
      {rows.map((row) => <Row key={row.type + ':' + row.id} row={row} />)}
    </Card>
  );
}

function Row({ row }: { row: DashboardRow }) {
  const c = CATEGORY[row.type];
  const age = humanAge(row.at);

  return (
    <div className="flex items-start gap-3 p-4">
      <span className={`mt-0.5 shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-bg-subtle border border-border`}>
        {c.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone={c.tone}>{c.label}</Badge>
          <div className="text-sm font-medium truncate">{row.title}</div>
        </div>
        <div className="mt-1 flex items-center gap-3 flex-wrap text-xs text-ink-muted">
          {row.context && <span className="truncate max-w-[32ch]">{row.context}</span>}
          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{age}</span>
          <OwnerChip userId={row.ownerUserId} label="שויך ל" size={16} />
          <RowMetaExtras row={row} />
        </div>
      </div>
      <RowPrimaryAction row={row} />
    </div>
  );
}

function RowMetaExtras({ row }: { row: DashboardRow }) {
  if (row.type === 'awaiting_response' || row.type === 'high_potential_draft') {
    return <span className="num">ציון {row.matchScore}</span>;
  }
  if (row.type === 'overdue_task') {
    return <Badge tone={row.priority === 'urgent' ? 'danger' : row.priority === 'high' ? 'warning' : 'neutral'}>{row.priority}</Badge>;
  }
  if (row.type === 'inbound_action' && row.unreadCount > 0) {
    return <Badge tone="brand">{row.unreadCount} לא נקראו</Badge>;
  }
  return null;
}

function RowPrimaryAction({ row }: { row: DashboardRow }) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Overdue tasks can be completed in-place — no navigation needed.
  const complete = useMutation({
    mutationFn: (id: string) => tasksApi.complete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dashboard', 'queue'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      toast.success('המשימה הושלמה');
    },
    onError: (e) => toast.error('ההשלמה נכשלה', (e as Error).message),
  });

  if (row.type === 'overdue_task') {
    const t = row as OverdueTaskRow;
    return (
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          variant="primary"
          leftIcon={<CheckCircle2 className="h-3.5 w-3.5" />}
          loading={complete.isPending && complete.variables === t.taskId}
          onClick={() => complete.mutate(t.taskId)}
        >
          סמן בוצע
        </Button>
        <Button size="sm" variant="subtle" onClick={() => navigate(t.route)}>פתח</Button>
      </div>
    );
  }

  // Every other row is a deep link into the completion flow.
  const icon = row.type === 'awaiting_response' ? <Send className="h-3.5 w-3.5" /> : undefined;
  return (
    <Link to={row.route} className="shrink-0">
      <Button size="sm" variant="primary" leftIcon={icon}>{row.primaryAction}</Button>
    </Link>
  );
}

function humanAge(at: string): string {
  const ms = Date.now() - new Date(at).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'עכשיו';
  if (m < 60) return `${m} דק'`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} שעות`;
  const d = Math.floor(h / 24);
  return `${d} ימים`;
}
