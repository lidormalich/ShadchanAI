import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ChevronLeft, Gauge, Plug, Shield, Sliders } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { Badge, Button, Card, CardBody, CardHeader, Input } from '@/components/ui/primitives';
import { LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { settingsApi, type SettingRow } from '@/services/api/settings';

interface Section {
  id: string;
  label: string;
  icon: ReactNode;
  content: ReactNode;
}

function SectionsList(): Section[] {
  return [
    { id: 'operational', label: 'ספי תפעול',   icon: <Gauge className="h-4 w-4" />,   content: <OperationalSettingsSection /> },
    { id: 'matching',    label: 'כללי התאמה',  icon: <Sliders className="h-4 w-4" />, content: <MatchingRulesSection /> },
    { id: 'channels',    label: 'ערוצים',      icon: <Plug className="h-4 w-4" />,    content: <ChannelsSettingsSection /> },
  ];
}

export function SettingsPage() {
  const { section } = useParams<{ section?: string }>();
  const sections = SectionsList();
  const active = sections.find((s) => s.id === section) ?? sections[0]!;

  return (
    <div className="grid grid-cols-12 gap-4">
      <aside className="col-span-3 xl:col-span-2">
        <Card>
          <div className="p-3">
            <h3 className="text-sm font-semibold mb-2 px-2">הגדרות</h3>
            <nav className="space-y-0.5">
              {sections.map((s) => (
                <NavLink
                  key={s.id}
                  to={`/settings/${s.id}`}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm',
                      isActive || s.id === active.id
                        ? 'bg-brand-50 text-brand-700 font-medium'
                        : 'text-ink-muted hover:bg-bg-hover',
                    )
                  }
                >
                  {s.icon}
                  {s.label}
                </NavLink>
              ))}
            </nav>
          </div>
        </Card>
      </aside>

      <section className="col-span-9 xl:col-span-10">{active.content}</section>
    </div>
  );
}

function OperationalSettingsSection() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.list(),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><h3 className="text-base font-semibold">ספי תור הדשבורד</h3></CardHeader>
        <CardBody>
          <div className="text-xs text-ink-muted mb-3">
            ערכים אלו שולטים במתי פריטים מופיעים בתור הפעולות בדשבורד. שינוי נכנס לתוקף מיד בשאילתה הבאה.
          </div>
          {list.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : list.isError ? (
            <div className="text-xs text-danger">טעינת ההגדרות נכשלה</div>
          ) : (
            <ul className="space-y-3">
              {(list.data?.data ?? []).map((row) => (
                <SettingRowEditor
                  key={row.key}
                  row={row}
                  onSaved={(v) => {
                    qc.setQueryData<{ data: SettingRow[]; meta?: unknown } | undefined>(
                      ['settings'],
                      (prev) => prev
                        ? { ...prev, data: prev.data.map((r) => r.key === row.key ? { ...r, value: v } : r) }
                        : prev,
                    );
                    qc.invalidateQueries({ queryKey: ['dashboard', 'queue'] });
                  }}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function SettingRowEditor({ row, onSaved }: { row: SettingRow; onSaved: (value: number) => void }) {
  const [value, setValue] = useState<number>(row.value);
  useEffect(() => { setValue(row.value); }, [row.value]);

  const save = useMutation({
    mutationFn: () => settingsApi.update(row.key, value),
    onSuccess: (res) => {
      toast.success('נשמר');
      onSaved(res.data.value);
    },
    onError: (err) => toast.error('השמירה נכשלה', (err as Error).message),
  });

  const dirty = value !== row.value;
  const invalid = !Number.isFinite(value) || value < row.min || value > row.max;

  return (
    <li className="rounded-md border border-border p-3">
      <div className="text-sm font-medium">{row.description}</div>
      <div className="text-[11px] text-ink-faint mt-0.5 font-mono">{row.key}</div>
      <div className="mt-2 flex items-center gap-2">
        <Input
          type="number"
          min={row.min}
          max={row.max}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => setValue(Number(e.target.value))}
          className="w-32 num"
        />
        <span className="text-[11px] text-ink-muted">ברירת מחדל: {row.default} · טווח: {row.min}–{row.max}</span>
        <Button
          size="sm"
          loading={save.isPending}
          disabled={!dirty || invalid}
          onClick={() => save.mutate()}
          className="ms-auto"
        >
          שמור
        </Button>
      </div>
    </li>
  );
}

function MatchingRulesSection() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><h3 className="text-base font-semibold">משקלי ניתוח דטרמיניסטי</h3></CardHeader>
        <CardBody>
          <div className="text-xs text-ink-muted mb-3">
            מנוע הניתוח משתמש ב־8 ממדים קבועים. הערכים כאן הם לתצוגה בלבד — עריכה תתאפשר בשלב הבא.
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <WeightRow label="גיל" value={0.15} />
            <WeightRow label="מגזר / תת-מגזר" value={0.15} />
            <WeightRow label="אורח חיים" value={0.15} />
            <WeightRow label="לימודים / עבודה" value={0.10} />
            <WeightRow label="מיקום" value={0.10} />
            <WeightRow label="ציפיות הדדיות" value={0.15} />
            <WeightRow label="שלב חיים" value={0.10} />
            <WeightRow label="גמישות / עקיפה יצירתית" value={0.10} />
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader><h3 className="text-base font-semibold">ספים לסיווג</h3></CardHeader>
        <CardBody className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <ThresholdTile label="בטוח" score={80} conf={70} />
          <ThresholdTile label="מאוזן" score={60} conf={50} />
          <ThresholdTile label="יצירתי" score={40} conf={30} />
          <ThresholdTile label="מסוכן" score={0} conf={0} />
        </CardBody>
      </Card>
    </div>
  );
}

function WeightRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-44 text-ink-muted">{label}</div>
      <div className="flex-1 h-1.5 bg-bg-subtle rounded-full overflow-hidden">
        <div className="bg-brand h-full rounded-full" style={{ width: `${value * 100}%` }} />
      </div>
      <div className="w-10 num text-end text-xs text-ink-muted">{(value * 100).toFixed(0)}%</div>
    </div>
  );
}

function ThresholdTile({ label, score, conf }: { label: string; score: number; conf: number }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="mt-1 text-sm">ציון ≥ <span className="num font-semibold">{score}</span></div>
      <div className="text-sm">ביטחון ≥ <span className="num font-semibold">{conf}</span></div>
    </div>
  );
}

function ChannelsSettingsSection() {
  return (
    <Card>
      <CardHeader
        actions={<Link to="/channels" className="text-xs text-brand-700 inline-flex items-center gap-1 hover:underline">עבור לניהול ערוצים <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" /></Link>}
      >
        <h3 className="text-base font-semibold">ערוצי WhatsApp</h3>
      </CardHeader>
      <CardBody>
        <p className="text-sm text-ink-muted">
          הערוצים מחולקים לפי תפקיד: <Badge tone="info" className="mx-1">profiles_source</Badge> למקור פרופילים ו־<Badge tone="purple" className="mx-1">match_sending</Badge> לשליחת הצעות.
        </p>
        <p className="text-xs text-ink-muted mt-2 inline-flex items-center gap-1">
          <Shield className="h-3.5 w-3.5" /> אסימונים וסודות מאוחסנים בצד השרת ואינם חשופים בממשק.
        </p>
      </CardBody>
    </Card>
  );
}

