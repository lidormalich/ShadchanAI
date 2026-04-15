import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle, Archive, ArrowUpRight, Clock, Heart, MessageSquare, Sparkles, Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { KpiCard } from '@/components/domain/KpiCard';
import { Badge, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { EmptyState, LoadingSkeleton } from '@/components/states/states';
import { matchesApi } from '@/services/api/matches';
import { tasksApi } from '@/services/api/tasks';
import { conversationsApi } from '@/services/api/conversations';
import { internalCandidatesApi } from '@/services/api/candidates';
import { label } from '@/utils/labels';
import type { Conversation, MatchSuggestion, Task } from '@/types/domain';

export function DashboardPage() {
  const activeInternals = useQuery({
    queryKey: ['internals', 'active-count'],
    queryFn: () => internalCandidatesApi.list({ status: 'active', limit: 1 }),
  });
  const dating = useQuery({
    queryKey: ['internals', 'dating-count'],
    queryFn: () => internalCandidatesApi.list({ status: 'dating', limit: 1 }),
  });
  const deferred = useQuery({
    queryKey: ['matches', 'deferred'],
    queryFn: () => matchesApi.list({ isDeferred: true, limit: 6 }),
  });
  const highPotential = useQuery({
    queryKey: ['matches', 'high-potential'],
    queryFn: () => matchesApi.list({ minScore: 75, status: 'draft', limit: 6 }),
  });
  const needsAction = useQuery({
    queryKey: ['conversations', 'needs-action'],
    queryFn: () => conversationsApi.list({ needsAction: true, limit: 8 }),
  });
  const overdueTasks = useQuery({
    queryKey: ['tasks', 'overdue'],
    queryFn: () => tasksApi.list({ status: 'open', dueBefore: new Date().toISOString(), limit: 8 }),
  });

  return (
    <div className="space-y-6">
      {/* ── KPI row ─────────────────────────────────────── */}
      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label="מועמדים פעילים"
          value={activeInternals.data?.meta?.total ?? '—'}
          icon={<Users className="h-5 w-5" />}
          hint="פנימיים שאינם סגורים/בהיכרות"
        />
        <KpiCard
          label="במצב היכרות"
          value={dating.data?.meta?.total ?? '—'}
          icon={<Heart className="h-5 w-5" />}
          tone="good"
        />
        <KpiCard
          label="הצעות מושהות"
          value={deferred.data?.meta?.total ?? '—'}
          icon={<Clock className="h-5 w-5" />}
          tone="warn"
          hint="יש לבחון פתיחה מחדש"
        />
        <KpiCard
          label="שיחות ממתינות"
          value={needsAction.data?.meta?.total ?? '—'}
          icon={<MessageSquare className="h-5 w-5" />}
          tone="warn"
        />
      </section>

      {/* ── Operational 2-column layout ─────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Action queue */}
        <Card className="xl:col-span-2">
          <CardHeader
            actions={
              <Link to="/chats" className="text-xs text-brand-700 inline-flex items-center gap-1 hover:underline">
                כל השיחות <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            }
          >
            <h2 className="text-base font-semibold">תור פעולה — שיחות ממתינות</h2>
            <p className="text-xs text-ink-muted mt-0.5">שיחות שדורשות טיפול של שדכן</p>
          </CardHeader>
          <CardBody className="!p-0">
            {needsAction.isLoading ? (
              <div className="p-5"><LoadingSkeleton rows={5} /></div>
            ) : needsAction.data?.data.length ? (
              <ul className="divide-y divide-border">
                {needsAction.data.data.map((c) => <ActionQueueRow key={c._id} conv={c} />)}
              </ul>
            ) : (
              <EmptyState
                icon={<MessageSquare className="h-8 w-8 text-ink-faint" />}
                title="אין שיחות הדורשות טיפול"
                description="כל השיחות עד כה קיבלו מענה — עבודה מצוינת."
              />
            )}
          </CardBody>
        </Card>

        {/* High potential */}
        <Card>
          <CardHeader
            actions={
              <Link to="/matches?minScore=75" className="text-xs text-brand-700 hover:underline">
                כל ההתאמות
              </Link>
            }
          >
            <h2 className="text-base font-semibold inline-flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand" /> התאמות בפוטנציאל גבוה
            </h2>
          </CardHeader>
          <CardBody className="!p-0">
            {highPotential.isLoading ? (
              <div className="p-5"><LoadingSkeleton rows={4} /></div>
            ) : highPotential.data?.data.length ? (
              <ul className="divide-y divide-border">
                {highPotential.data.data.map((m) => <MatchMiniRow key={m._id} match={m} />)}
              </ul>
            ) : (
              <EmptyState title="אין הצעות חדשות בציון גבוה" />
            )}
          </CardBody>
        </Card>

        {/* Deferred */}
        <Card className="xl:col-span-2">
          <CardHeader
            actions={
              <Link to="/matches?isDeferred=true" className="text-xs text-brand-700 hover:underline">
                כל ההצעות המושהות
              </Link>
            }
          >
            <h2 className="text-base font-semibold inline-flex items-center gap-2">
              <Clock className="h-4 w-4" /> הצעות מושהות — בחינה לפתיחה
            </h2>
          </CardHeader>
          <CardBody className="!p-0">
            {deferred.isLoading ? (
              <div className="p-5"><LoadingSkeleton rows={3} /></div>
            ) : deferred.data?.data.length ? (
              <ul className="divide-y divide-border">
                {deferred.data.data.map((m) => <MatchMiniRow key={m._id} match={m} showDeferred />)}
              </ul>
            ) : (
              <EmptyState
                icon={<Archive className="h-8 w-8 text-ink-faint" />}
                title="אין הצעות מושהות כרגע"
              />
            )}
          </CardBody>
        </Card>

        {/* Overdue tasks */}
        <Card>
          <CardHeader actions={<Link to="/tasks" className="text-xs text-brand-700 hover:underline">כל המשימות</Link>}>
            <h2 className="text-base font-semibold inline-flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-danger" /> משימות באיחור
            </h2>
          </CardHeader>
          <CardBody className="!p-0">
            {overdueTasks.isLoading ? (
              <div className="p-5"><LoadingSkeleton rows={4} /></div>
            ) : overdueTasks.data?.data.length ? (
              <ul className="divide-y divide-border">
                {overdueTasks.data.data.map((t) => <TaskMiniRow key={t._id} task={t} />)}
              </ul>
            ) : (
              <EmptyState title="אין משימות באיחור" />
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function ActionQueueRow({ conv }: { conv: Conversation }) {
  return (
    <li className="px-5 py-3 flex items-center justify-between gap-3 hover:bg-bg-hover">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge tone={conv.channelRole === 'profiles_source' ? 'info' : 'purple'}>
            {label('channelRole', conv.channelRole)}
          </Badge>
          <span className="text-xs text-ink-faint">{conv.accountDisplayName}</span>
        </div>
        <div className="text-sm font-medium text-ink mt-1 truncate">{conv.participantName ?? 'משתתף ללא שם'}</div>
        <div className="text-xs text-ink-muted">
          {conv.unreadCount > 0 ? `${conv.unreadCount} הודעות חדשות` : 'ממתין לתגובה'}
        </div>
      </div>
      <Link to={`/chats?c=${conv._id}`} className="text-xs text-brand-700 inline-flex items-center gap-1 hover:underline shrink-0">
        פתח <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </li>
  );
}

function MatchMiniRow({ match, showDeferred }: { match: MatchSuggestion; showDeferred?: boolean }) {
  const scoreTone = match.matchScore >= 80 ? 'text-success' : match.matchScore >= 60 ? 'text-brand-700' : 'text-warning';
  return (
    <li className="px-5 py-3 flex items-center justify-between gap-3 hover:bg-bg-hover">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge tone={match.matchType === 'safe' ? 'success' : match.matchType === 'balanced' ? 'brand' : 'warning'}>
            {label('matchType', match.matchType)}
          </Badge>
          {showDeferred && match.deferredReason && (
            <span className="text-xs text-ink-muted">{match.deferredReason}</span>
          )}
        </div>
        <div className="text-xs text-ink-muted mt-1 font-mono">
          {match.internalCandidateId.slice(-6)} ↔ {match.externalCandidateId.slice(-6)}
        </div>
      </div>
      <Link to={`/matches/${match._id}`} className="text-end shrink-0 hover:opacity-75">
        <div className={`text-lg font-semibold num ${scoreTone}`}>{match.matchScore}</div>
        <div className="text-xs text-ink-muted num">ב {match.confidenceScore}</div>
      </Link>
    </li>
  );
}

function TaskMiniRow({ task }: { task: Task }) {
  return (
    <li className="px-5 py-3 hover:bg-bg-hover">
      <div className="text-sm font-medium text-ink truncate">{task.title}</div>
      <div className="text-xs text-ink-muted mt-0.5 flex items-center gap-2">
        <Badge tone={task.priority === 'urgent' ? 'danger' : task.priority === 'high' ? 'warning' : 'neutral'}>
          {label('taskPriority', task.priority)}
        </Badge>
        {task.dueAt && <span>תאריך יעד: {new Date(task.dueAt).toLocaleDateString('he-IL')}</span>}
      </div>
    </li>
  );
}
