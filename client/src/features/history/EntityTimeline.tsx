// ═══════════════════════════════════════════════════════════
// EntityTimeline — reads /api/audit-logs?entityType=...&entityId=...
// Renders the action/timestamp/actor stream for one entity.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { EmptyState, LoadingSkeleton } from '@/components/states/states';
import { auditApi, type AuditLogEntry } from '@/services/api/audit';

const ACTION_LABEL: Record<string, string> = {
  create: 'נוצר',
  update: 'עודכן',
  delete: 'נמחק',
  archive: 'הועבר לארכיון',
  restore: 'שוחזר',
  status_change: 'שינוי סטטוס',
  match_sent: 'הצעה נשלחה',
  match_approved: 'ההצעה אושרה',
  match_declined: 'ההצעה נדחתה',
  message_sent: 'הודעה נשלחה',
  ai_query: 'שאילתת AI',
  login: 'התחברות',
  export: 'ייצוא',
};

export type TimelineEntityType =
  | 'internal_candidate'
  | 'external_candidate'
  | 'match_suggestion'
  | 'conversation'
  | 'message'
  | 'channel'
  | 'task'
  | 'note'
  | 'user';

export function EntityTimeline({
  entityType,
  entityId,
  title = 'ציר זמן',
  limit = 50,
  asCard = true,
}: {
  entityType: TimelineEntityType;
  entityId: string;
  title?: string;
  limit?: number;
  asCard?: boolean;
}) {
  const q = useQuery({
    queryKey: ['audit-logs', entityType, entityId, limit],
    queryFn: () => auditApi.list({ entityType, entityId, limit }),
    enabled: !!entityId,
  });

  const body = q.isLoading ? (
    <LoadingSkeleton rows={4} />
  ) : q.isError ? (
    <div className="text-xs text-danger">טעינת ההיסטוריה נכשלה</div>
  ) : (q.data?.data ?? []).length === 0 ? (
    <EmptyState title="אין פעילות רשומה" description="פעולות על פריט זה יופיעו כאן עם התרחשותן." />
  ) : (
    <ol className="space-y-2">
      {(q.data!.data as AuditLogEntry[]).map((entry) => (
        <li key={entry._id} className="flex items-start gap-2 text-sm border-s-2 border-border ps-3">
          <Clock className="h-3.5 w-3.5 mt-1 text-ink-faint shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{ACTION_LABEL[entry.actionType] ?? entry.actionType}</div>
            <div className="text-[11px] text-ink-faint mt-0.5">
              {new Date(entry.createdAt).toLocaleString('he-IL')}
              {entry.performedBy && <> · מבצע: <span className="font-mono">{entry.performedBy.slice(-6)}</span></>}
            </div>
            {entry.metadata && renderMeta(entry.metadata)}
          </div>
        </li>
      ))}
    </ol>
  );

  if (!asCard) return <div className="space-y-2">{body}</div>;
  return (
    <Card>
      <CardHeader><h3 className="text-sm font-semibold">{title}</h3></CardHeader>
      <CardBody>{body}</CardBody>
    </Card>
  );
}

function renderMeta(meta: Record<string, unknown>): React.ReactNode {
  const keys = Object.keys(meta).filter((k) => meta[k] !== undefined && meta[k] !== null && meta[k] !== '');
  if (keys.length === 0) return null;
  return (
    <div className="text-[11px] text-ink-muted mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
      {keys.slice(0, 6).map((k) => (
        <span key={k}><span className="text-ink-faint">{k}:</span> {String(meta[k])}</span>
      ))}
    </div>
  );
}
