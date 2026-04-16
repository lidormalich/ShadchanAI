// ═══════════════════════════════════════════════════════════
// TasksRail — reusable tasks panel for entity pages.
// Lists tasks linked to the entity (via the existing task
// filters) and lets the operator create a new task prefilled
// with the related entity.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { EmptyState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { tasksApi } from '@/services/api/tasks';
import { TaskForm, type TaskRelatedEntity } from '@/features/forms/TaskForm';
import { OwnerChip } from '@/features/users/OwnerChip';
import { label } from '@/utils/labels';
import type { Task } from '@/types/domain';

function relatedToQuery(rel: TaskRelatedEntity): Record<string, unknown> {
  switch (rel.type) {
    case 'internal_candidate': return { internalCandidateId: rel.id };
    case 'external_candidate': return { externalCandidateId: rel.id };
    case 'match_suggestion':   return { matchSuggestionId: rel.id };
    case 'conversation':       return { conversationId: rel.id };
  }
}

export function TasksRail({
  related,
  title = 'משימות',
}: {
  related: TaskRelatedEntity;
  title?: string;
}) {
  const qc = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);

  const list = useQuery({
    queryKey: ['tasks', 'related', related.type, related.id],
    queryFn: () => tasksApi.list({ ...relatedToQuery(related), limit: 50 }),
    enabled: !!related.id,
  });

  const complete = useMutation({
    mutationFn: (id: string) => tasksApi.complete(id, {}),
    onSuccess: (res) => {
      // Patch the cached list so completion reflects instantly.
      qc.setQueryData<{ data: Task[]; meta?: unknown } | undefined>(
        ['tasks', 'related', related.type, related.id],
        (prev) => prev
          ? { ...prev, data: prev.data.map((t) => t._id === res.data._id ? res.data : t) }
          : prev,
      );
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err) => toast.error('סגירת המשימה נכשלה', (err as Error).message),
  });

  const items = list.data?.data ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Button size="sm" variant="secondary" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setFormOpen(true)}>
            משימה חדשה
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        {list.isLoading ? (
          <LoadingSkeleton rows={3} />
        ) : list.isError ? (
          <div className="text-xs text-danger">טעינת המשימות נכשלה</div>
        ) : items.length === 0 ? (
          <EmptyState title="אין משימות" description="צור משימה ראשונה מקושרת לישות הזו." />
        ) : (
          <ul className="space-y-2">
            {items.map((t) => (
              <li key={t._id} className="rounded-md border border-border bg-white p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{t.title}</div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-ink-muted">
                      <Badge tone={t.status === 'completed' ? 'success' : t.status === 'open' ? 'brand' : 'neutral'}>
                        {label('taskStatus', t.status)}
                      </Badge>
                      <Badge tone={t.priority === 'urgent' ? 'danger' : t.priority === 'high' ? 'warning' : 'neutral'}>
                        {label('taskPriority', t.priority)}
                      </Badge>
                      {t.dueAt && <span>עד {new Date(t.dueAt).toLocaleDateString('he-IL')}</span>}
                      <OwnerChip userId={t.assignedTo} label="שויך ל" size={16} />
                    </div>
                  </div>
                  {t.status !== 'completed' && t.status !== 'cancelled' && (
                    <Button
                      size="sm"
                      variant="subtle"
                      leftIcon={<CheckCircle2 className="h-3.5 w-3.5" />}
                      loading={complete.isPending && complete.variables === t._id}
                      onClick={() => complete.mutate(t._id)}
                    >
                      סגור
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>

      <TaskForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        relatedEntity={related}
      />
    </Card>
  );
}
