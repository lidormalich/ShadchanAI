import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus } from 'lucide-react';
import { useState } from 'react';
import { tasksApi } from '@/services/api/tasks';
import { Badge, Button, Card, CardBody, CardHeader, Select } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { TaskForm } from '@/features/forms/TaskForm';
import { toast } from '@/components/ui/Toast';
import { Pagination } from '@/components/ui/Pagination';
import { label } from '@/utils/labels';
import type { Task } from '@/types/domain';

export function TasksPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('open');
  const [priority, setPriority] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [page, setPage] = useState(1);
  const limit = 25;

  const list = useQuery({
    queryKey: ['tasks', { status, priority, page }],
    queryFn: () => tasksApi.list({
      status: status || undefined,
      priority: priority || undefined,
      page,
      limit,
    }),
  });

  const filterKey = `${status}|${priority}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    if (page !== 1) setPage(1);
  }

  const complete = useMutation({
    mutationFn: (id: string) => tasksApi.complete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      toast.success('המשימה הושלמה');
    },
    onError: (err) => toast.error('ההשלמה נכשלה', (err as Error).message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">משימות ומעקב</h2>
          <p className="text-sm text-ink-muted">משימות פעילות של השדכנות</p>
        </div>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setFormOpen(true)}>משימה חדשה</Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">כל הסטטוסים</option>
              <option value="open">פתוחות</option>
              <option value="in_progress">בטיפול</option>
              <option value="completed">הושלמו</option>
              <option value="deferred">נדחו</option>
            </Select>
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="">כל העדיפויות</option>
              <option value="urgent">דחוף</option>
              <option value="high">גבוהה</option>
              <option value="medium">בינונית</option>
              <option value="low">נמוכה</option>
            </Select>
          </div>
        </CardHeader>
        <CardBody className="!p-0">
          {list.isError ? (
            <ErrorState description={(list.error as Error).message} onRetry={() => list.refetch()} />
          ) : list.isLoading ? (
            <div className="p-5"><LoadingSkeleton rows={5} /></div>
          ) : list.data?.data.length ? (
            <ul className="divide-y divide-border">
              {list.data.data.map((t) => (
                <TaskRow key={t._id} task={t} onComplete={() => complete.mutate(t._id)} />
              ))}
            </ul>
          ) : (
            <EmptyState title="אין משימות" description="נראה שהכול בסדר. כל הכבוד!" />
          )}
        </CardBody>
        {list.data && (
          <Pagination
            page={page}
            totalPages={list.data.meta?.totalPages ?? 1}
            total={list.data.meta?.total}
            onChange={setPage}
          />
        )}
      </Card>
      <TaskForm open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function TaskRow({ task, onComplete }: { task: Task; onComplete: () => void }) {
  const overdue = task.dueAt && task.status === 'open' && new Date(task.dueAt) < new Date();
  return (
    <li className="px-5 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone={task.priority === 'urgent' ? 'danger' : task.priority === 'high' ? 'warning' : 'neutral'}>
            {label('taskPriority', task.priority)}
          </Badge>
          <Badge tone="neutral">{label('taskType', task.type)}</Badge>
          {overdue && <Badge tone="danger">באיחור</Badge>}
        </div>
        <div className="text-sm font-medium mt-1">{task.title}</div>
        {task.description && <div className="text-xs text-ink-muted truncate max-w-xl">{task.description}</div>}
        {task.dueAt && (
          <div className="text-xs text-ink-faint mt-1">
            תאריך יעד: {new Date(task.dueAt).toLocaleDateString('he-IL')}
          </div>
        )}
      </div>
      {task.status !== 'completed' && task.status !== 'cancelled' && (
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<CheckCircle2 className="h-3.5 w-3.5" />}
          onClick={onComplete}
        >
          סמן כבוצע
        </Button>
      )}
    </li>
  );
}
