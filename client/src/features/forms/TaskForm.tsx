// ═══════════════════════════════════════════════════════════
// Task create / edit form.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Input, Select, Textarea } from '@/components/ui/primitives';
import { toast } from '@/components/ui/Toast';
import { tasksApi } from '@/services/api/tasks';
import { label } from '@/utils/labels';
import type { Task } from '@/types/domain';

const TYPES = ['follow_up', 'call_candidate', 'send_proposal', 'verify_profile', 'check_dating_status', 'review_match', 'general'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

type Values = Partial<Task>;

export function TaskForm({
  open, onClose, initial,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Task;
}) {
  const qc = useQueryClient();
  const [v, setV] = useState<Values>({});
  useEffect(() => { setV(initial ?? { type: 'general', priority: 'medium' }); }, [initial]);

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
            <Select value={v.type ?? 'general'} onChange={(e) => set('type', e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{label('taskType', t)}</option>)}
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">עדיפות</label>
            <Select value={v.priority ?? 'medium'} onChange={(e) => set('priority', e.target.value)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{label('taskPriority', p)}</option>)}
            </Select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">תאריך יעד</label>
          <Input
            type="date"
            value={v.dueAt?.slice(0, 10) ?? ''}
            onChange={(e) => set('dueAt', e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">תיאור</label>
          <Textarea rows={3} value={v.description ?? ''} onChange={(e) => set('description', e.target.value)} />
        </div>
      </div>
    </Dialog>
  );
}
