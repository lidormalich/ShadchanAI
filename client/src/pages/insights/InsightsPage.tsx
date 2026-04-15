import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Heart, Timer, Users2 } from 'lucide-react';
import { KpiCard } from '@/components/domain/KpiCard';
import { Badge, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { EmptyState, LoadingSkeleton } from '@/components/states/states';
import { matchesApi } from '@/services/api/matches';
import { internalCandidatesApi, externalCandidatesApi } from '@/services/api/candidates';

export function InsightsPage() {
  // Until a dedicated insights endpoint ships, these are derived counts
  // from the existing list/pipeline endpoints.
  const active = useQuery({ queryKey: ['ins', 'active-internals'], queryFn: () => internalCandidatesApi.list({ status: 'active', limit: 1 }) });
  const dating = useQuery({ queryKey: ['ins', 'dating'], queryFn: () => internalCandidatesApi.list({ status: 'dating', limit: 1 }) });
  const stale = useQuery({ queryKey: ['ins', 'stale-externals'], queryFn: () => externalCandidatesApi.list({ limit: 10 }) });
  const safe = useQuery({ queryKey: ['ins', 'safe'], queryFn: () => matchesApi.list({ matchType: 'safe', limit: 1 }) });
  const risky = useQuery({ queryKey: ['ins', 'risky'], queryFn: () => matchesApi.list({ matchType: 'risky', limit: 1 }) });
  const deferred = useQuery({ queryKey: ['ins', 'deferred'], queryFn: () => matchesApi.list({ isDeferred: true, limit: 1 }) });

  const staleCount = (stale.data?.data ?? []).filter((c) => c.staleAt).length;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">תובנות תפעוליות</h2>
        <p className="text-sm text-ink-muted">מבט כולל על הבריאות והזרימה של מערכת השידוך</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard label="פעילים" value={active.data?.meta?.total ?? '—'} icon={<Users2 className="h-5 w-5" />} />
        <KpiCard label="בהיכרות" value={dating.data?.meta?.total ?? '—'} icon={<Heart className="h-5 w-5" />} tone="good" />
        <KpiCard label="הצעות בטוחות" value={safe.data?.meta?.total ?? '—'} tone="good" />
        <KpiCard label="הצעות בסיכון" value={risky.data?.meta?.total ?? '—'} tone="bad" icon={<AlertTriangle className="h-5 w-5" />} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold inline-flex items-center gap-2"><Timer className="h-4 w-4" /> משפך הצעות</h3>
          </CardHeader>
          <CardBody>
            <FunnelStub />
            <p className="text-xs text-ink-muted mt-3">
              ⓘ תצוגה מפורטת של המשפך תופיע לאחר שתוקם נקודת קצה ייעודית ל־insights.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> אזורים שדורשים תשומת לב</h3>
          </CardHeader>
          <CardBody className="space-y-2">
            <AttentionRow label="הצעות מושהות" count={deferred.data?.meta?.total ?? 0} tone="warning" />
            <AttentionRow label="מועמדים חיצוניים ישנים" count={staleCount} tone="warning" />
            <AttentionRow label="הצעות בסיכון גבוה" count={risky.data?.meta?.total ?? 0} tone="danger" />
          </CardBody>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <h3 className="text-sm font-semibold inline-flex items-center gap-2"><Activity className="h-4 w-4" /> ביצועי שדכנים</h3>
          </CardHeader>
          <CardBody>
            <EmptyState title="נתונים על ביצועי שדכנים" description="יופיעו כאן לאחר הוספת נקודת קצה ייעודית." />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function FunnelStub() {
  const stages = [
    { label: 'נוצרו', width: 100, tone: 'bg-brand' },
    { label: 'אושרו', width: 70, tone: 'bg-brand/80' },
    { label: 'נשלחו', width: 55, tone: 'bg-brand/60' },
    { label: 'התקבלו', width: 30, tone: 'bg-success/80' },
    { label: 'היכרות', width: 15, tone: 'bg-purple-500/80' },
  ];
  return (
    <div className="space-y-2">
      {stages.map((s) => (
        <div key={s.label} className="flex items-center gap-3">
          <div className="w-20 text-xs text-ink-muted">{s.label}</div>
          <div className="flex-1 h-2 bg-bg-subtle rounded-full overflow-hidden">
            <div className={`${s.tone} h-full rounded-full transition-all`} style={{ width: `${s.width}%` }} />
          </div>
          <div className="w-12 text-xs num text-end text-ink-muted">{s.width}%</div>
        </div>
      ))}
    </div>
  );
}

function AttentionRow({ label, count, tone }: { label: string; count: number; tone: 'warning' | 'danger' }) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="text-sm">{label}</div>
      <Badge tone={tone}>{count}</Badge>
    </div>
  );
}
