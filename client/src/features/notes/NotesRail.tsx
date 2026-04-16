// ═══════════════════════════════════════════════════════════
// NotesRail — reusable notes panel mounted on any entity page.
// Talks to the existing /api/notes endpoints via notesApi.
// entityType values follow the shared NoteEntityType enum.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, CardBody, CardHeader, Textarea } from '@/components/ui/primitives';
import { EmptyState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { notesApi } from '@/services/api/notes';

export type NotesEntityType =
  | 'internal_candidate'
  | 'external_candidate'
  | 'match_suggestion'
  | 'conversation'
  | 'task';

export function NotesRail({
  entityType,
  entityId,
  title = 'הערות',
}: {
  entityType: NotesEntityType;
  entityId: string;
  title?: string;
}) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');

  const list = useQuery({
    queryKey: ['notes', entityType, entityId],
    queryFn: () => notesApi.list({ entityType, entityId, limit: 50, sort: 'createdAt', order: 'desc' }),
    enabled: !!entityId,
  });

  const create = useMutation({
    mutationFn: (text: string) => notesApi.create({ entityType, entityId, body: text }),
    onSuccess: (res) => {
      // Optimistic-ish: prepend the new note so the operator sees it immediately
      qc.setQueryData<{ data: unknown[]; meta?: unknown } | undefined>(
        ['notes', entityType, entityId],
        (prev) => prev
          ? { ...prev, data: [res.data, ...(prev.data as unknown[])] }
          : prev,
      );
      qc.invalidateQueries({ queryKey: ['notes', entityType, entityId] });
      setBody('');
    },
    onError: (err) => toast.error('שמירת ההערה נכשלה', (err as Error).message),
  });

  const items = list.data?.data ?? [];

  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold">{title}</h3>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="space-y-2">
          <Textarea
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="הוסף הערה על ההקשר הזה…"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              loading={create.isPending}
              disabled={!body.trim()}
              onClick={() => create.mutate(body.trim())}
            >
              הוסף הערה
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {list.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : list.isError ? (
            <div className="text-xs text-danger">טעינת ההערות נכשלה</div>
          ) : items.length === 0 ? (
            <EmptyState title="אין הערות" description="הוסף הערה ראשונה למעלה." />
          ) : (
            <ul className="space-y-2">
              {items.map((n) => (
                <li key={(n as { _id: string })._id} className="rounded-md border border-border bg-white p-2">
                  <div className="text-sm whitespace-pre-wrap">{(n as { body: string }).body}</div>
                  <div className="text-[11px] text-ink-faint mt-1">
                    {new Date((n as { createdAt: string }).createdAt).toLocaleString('he-IL')}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
