// ═══════════════════════════════════════════════════════════
// Task create / edit form.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Input, Select, Textarea } from '@/components/ui/primitives';
import { toast } from '@/components/ui/Toast';
import { tasksApi } from '@/services/api/tasks';
import { useUsers } from '@/features/users/useUsers';
import { label } from '@/utils/labels';
import type { Task } from '@/types/domain';

const TYPES = ['follow_up', 'call_candidate', 'send_proposal', 'verify_profile', 'check_dating_status', 'review_match', 'general'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

type Values = Partial<Task>;

export type TaskRelatedEntity =
  | { type: 'internal_candidate'; id: string }
  | { type: 'external_candidate'; id: string }
  | { type: 'match_suggestion'; id: string }
  | { type: 'conversation'; id: string };

function applyRelatedEntity(values: Values, related?: TaskRelatedEntity): Values {
  if (!related) return values;
  const next: Values = { ...values };
  if (related.type === 'internal_candidate') next.internalCandidateId = related.id;
  if (related.type === 'external_candidate') next.externalCandidateId = related.id;
  if (related.type === 'match_suggestion') next.matchSuggestionId = related.id;
  if (related.type === 'conversation') next.conversationId = related.id;
  return next;
}

export function TaskForm({
  open, onClose, initial, relatedEntity,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Task;
  // When creating from an entity page, prefill the related link so the
  // new task is attached to the candidate / match / conversation it was
  // opened from. Ignored in edit mode.
  relatedEntity?: TaskRelatedEntity;
}) {
  const qc = useQueryClient();
  const users = useUsers();
  const [v, setV] = useState<Values>({});
  useEffect(() => {
    const base: Values = initial ?? { type: 'general', priority: 'medium' };
    setV(initial ? base : applyRelatedEntity(base, relatedEntity));
  }, [initial, relatedEntity]);

  const save = useMutation({
    mutationFn: async () => {
      const body: Values = {
        ...v,
        title: v.title?.trim(),
        dueAt: v.dueAt ? new Date(v.dueAt).toISOString() : undefined,
      };
      return initial?._id
        ? tasksApi.update(initial._id, body)
        : tasksApi.create(body);
    },
    onSuccess: () => {
      toast.success(initial ? 'המשימה עודכנה' : 'המשימה נוצרה');
      qc.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    },
    onError: (err) => toast.error('השמירה נכשלה', (err as Error).message),
  });

  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((p) => ({ ...p, [k]: val }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? 'עריכת משימה' : 'יצירת משימה'}
      primaryAction={{ label: 'שמור', onClick: () => save.mutate(), loading: save.isPending }}
      secondaryAction={{ label: 'ביטול', onClick: onClose }}
    >
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium mb-1">כותרת <span className="text-danger">*</span></label>
          <Input value={v.title ?? ''} onChange={(e) => set('title', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">סוג</label>
            <Select value={v.type ?? 'general'} onChange={(e) => set('type', e.target.value as Values['type'])}>
              {TYPES.map((t) => <option key={t} value={t}>{label('taskType', t)}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">עדיפות</label>
            <Select value={v.priority ?? 'medium'} onChange={(e) => set('priority', e.target.value as Values['priority'])}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{label('taskPriority', p)}</option>)}
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">תאריך יעד</label>
            <Input
              type="date"
              value={v.dueAt?.slice(0, 10) ?? ''}
              onChange={(e) => set('dueAt', e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">שויך ל</label>
            <Select
              value={v.assignedTo ?? ''}
              onChange={(e) => set('assignedTo', e.target.value || undefined)}
              disabled={users.isLoading}
            >
              <option value="">— לא שויך —</option>
              {(users.data?.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">תיאור</label>
          <Textarea rows={3} value={v.description ?? ''} onChange={(e) => set('description', e.target.value)} />
        </div>
      </div>
    </Dialog>
  );
}
