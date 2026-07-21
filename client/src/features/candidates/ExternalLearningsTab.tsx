// ═══════════════════════════════════════════════════════════
// ExternalLearningsTab — "מה למדנו"
//
// External candidates have no AI-summarised insight (that's internal-only).
// Two sources here:
//   • Manual — free-text learnings the operator adds by hand ("משהו משלי").
//   • Auto   — the per-side "why not" reasons recorded on the candidate's
//              closed suggestions.
// Nothing in either ⇒ a clear "nothing learned yet" state, with the manual
// input still available so the operator can teach the first thing.
// ═══════════════════════════════════════════════════════════

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, Plus, Trash2, UserPen } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, CardBody, CardHeader, Textarea } from '@/components/ui/primitives';
import { ErrorState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { externalCandidatesApi, type ExternalLearningItem, type ManualLearningItem } from '@/services/api/candidates';
import { label } from '@/utils/labels';
import { formatDate } from '@/utils/format';

export function ExternalLearningsTab({ candidateId }: { candidateId: string }) {
  const learnings = useQuery({
    queryKey: ['external', candidateId, 'learnings'],
    queryFn: () => externalCandidatesApi.learnings(candidateId),
    enabled: !!candidateId,
  });

  if (learnings.isLoading) return <LoadingSkeleton rows={4} />;
  if (learnings.isError) {
    return <ErrorState description={(learnings.error as Error).message} onRetry={() => learnings.refetch()} />;
  }

  const items = learnings.data?.data.items ?? [];
  const manual = learnings.data?.data.manual ?? [];

  return (
    <div className="space-y-4">
      <ManualLearnings candidateId={candidateId} manual={manual} />
      <AutoLearnings items={items} />
    </div>
  );
}

// ── Manual: the operator teaches something themselves ──────
function ManualLearnings({ candidateId, manual }: { candidateId: string; manual: ManualLearningItem[] }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['external', candidateId, 'learnings'] });

  const add = useMutation({
    mutationFn: () => externalCandidatesApi.addLearning(candidateId, text.trim()),
    onSuccess: () => { setText(''); invalidate(); toast.success('נשמר', 'התובנה נוספה למה שלמדנו'); },
    onError: (e) => toast.error('השמירה נכשלה', (e as Error).message),
  });

  const remove = useMutation({
    mutationFn: (learningId: string) => externalCandidatesApi.removeLearning(candidateId, learningId),
    onSuccess: () => { invalidate(); toast.success('נמחק'); },
    onError: (e) => toast.error('המחיקה נכשלה', (e as Error).message),
  });

  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold inline-flex items-center gap-1.5">
          <UserPen className="h-4 w-4 text-brand-700" />
          מה שאני לימדתי
        </h3>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="space-y-2">
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="למד משהו על המועמד/ת — למשל: מחפש/ת דווקא בוגר/ת ישיבה · לא מעוניין/ת בהצעות מחוץ לירושלים"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              leftIcon={<Plus className="h-3.5 w-3.5" />}
              loading={add.isPending}
              disabled={!text.trim()}
              onClick={() => add.mutate()}
            >
              הוסף תובנה
            </Button>
          </div>
        </div>

        {manual.length === 0 ? (
          <div className="text-xs text-ink-faint">עדיין לא הוספת תובנות ידניות.</div>
        ) : (
          <ul className="space-y-2">
            {manual.map((m) => (
              <li key={m.id} className="rounded-md border border-border bg-bg-subtle p-2.5 flex items-start gap-2">
                <p className="text-sm text-ink whitespace-pre-wrap leading-relaxed flex-1 min-w-0">{m.text}</p>
                <span className="text-[11px] text-ink-faint shrink-0">{formatDate(m.createdAt)}</span>
                <button
                  type="button"
                  onClick={() => remove.mutate(m.id)}
                  disabled={remove.isPending}
                  title="מחק תובנה"
                  className="shrink-0 text-ink-faint hover:text-danger transition-colors disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

// ── Auto: what the closed suggestions taught us ────────────
function AutoLearnings({ items }: { items: ExternalLearningItem[] }) {
  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold inline-flex items-center gap-1.5">
          <Brain className="h-4 w-4 text-brand-700" />
          נלמד מההצעות שנסגרו
        </h3>
      </CardHeader>
      <CardBody className="space-y-3">
        {items.length === 0 ? (
          <div className="text-xs text-ink-faint">
            עדיין לא נלמד כלום אוטומטית — אין הצעות שנסגרו עם סיבה. ברגע שתסגור הצעה ותרשום למה היא לא התאימה, זה יופיע כאן.
          </div>
        ) : (
          <>
            <div className="text-xs text-ink-muted">
              מבוסס על {items.length} הצעות שנסגרו עם סיבה. נאסף אוטומטית — לא נוגע בציון.
            </div>
            {items.map((it) => <LearningItem key={it.matchSuggestionId} item={it} />)}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function LearningItem({ item }: { item: ExternalLearningItem }) {
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link to={`/matches/${item.matchSuggestionId}`} className="text-sm font-medium hover:underline">
          מול {item.partnerName}
        </Link>
        <div className="flex items-center gap-2">
          <Badge tone="neutral">{label('matchStatus', item.status)}</Badge>
          {item.closedAt && <span className="text-[11px] text-ink-faint">{formatDate(item.closedAt)}</span>}
        </div>
      </div>
      {item.aboutExternal && <ReasonRow title="לגבי המועמד/ת" text={item.aboutExternal} emphasis />}
      {item.aboutPartner && <ReasonRow title={`לגבי ${item.partnerName}`} text={item.aboutPartner} />}
      {item.note && <ReasonRow title="הערת סגירה" text={item.note} />}
    </div>
  );
}

function ReasonRow({ title, text, emphasis }: { title: string; text: string; emphasis?: boolean }) {
  return (
    <div className={`rounded p-2 border ${emphasis ? 'border-amber-200 bg-amber-50' : 'border-border bg-bg-subtle'}`}>
      <div className={`text-[11px] font-semibold mb-0.5 ${emphasis ? 'text-amber-700' : 'text-ink-muted'}`}>{title}</div>
      <p className="text-sm text-ink whitespace-pre-wrap leading-relaxed">{text}</p>
    </div>
  );
}
