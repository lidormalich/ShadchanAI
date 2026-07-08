import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bell, Brain, ChevronLeft, Coins, Cpu, Gauge, Plug, Shield, Sliders, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { Badge, Button, Card, CardBody, CardHeader, Input, Select } from '@/components/ui/primitives';
import { LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { settingsApi, type SettingRow, type SettingValue } from '@/services/api/settings';
import { extractionApi, type CardLabelField } from '@/services/api/extraction';
import { AiCostsSection } from './AiCostsSection';

interface Section {
  id: string;
  label: string;
  icon: ReactNode;
  content: ReactNode;
}

function SectionsList(): Section[] {
  return [
    { id: 'operational', label: 'ספי תפעול',    icon: <Gauge className="h-4 w-4" />,   content: <OperationalSettingsSection /> },
    { id: 'matching',    label: 'כללי התאמה',   icon: <Sliders className="h-4 w-4" />, content: <MatchingRulesSection /> },
    { id: 'ai',          label: 'מנוע AI',      icon: <Cpu className="h-4 w-4" />,     content: <AiEngineSection /> },
    { id: 'pipeline',    label: 'עיבוד ולמידה', icon: <Brain className="h-4 w-4" />,   content: <PipelineSettingsSection /> },
    { id: 'ai-costs',    label: 'עלויות AI',    icon: <Coins className="h-4 w-4" />,   content: <AiCostsSection /> },
    { id: 'notifications', label: 'התראות',     icon: <Bell className="h-4 w-4" />,    content: <NotificationsSettingsSection /> },
    { id: 'channels',    label: 'ערוצים',       icon: <Plug className="h-4 w-4" />,    content: <ChannelsSettingsSection /> },
  ];
}

export function SettingsPage() {
  const { section } = useParams<{ section?: string }>();
  const sections = SectionsList();
  const active = sections.find((s) => s.id === section) ?? sections[0]!;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      <aside className="lg:col-span-3 xl:col-span-2">
        <Card>
          <div className="p-3">
            <h3 className="text-sm font-semibold mb-2 px-2">הגדרות</h3>
            {/* Horizontal scroll row on mobile; stacked column at lg+ */}
            <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0.5">
              {sections.map((s) => (
                <NavLink
                  key={s.id}
                  to={`/settings/${s.id}`}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm whitespace-nowrap shrink-0',
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

      <section className="lg:col-span-9 xl:col-span-10">{active.content}</section>
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
              {(list.data?.data ?? [])
                .filter((row) => row.key.startsWith('dashboard.') || row.key.startsWith('outbound.'))
                .map((row) => (
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

function engineOptionLabel(opt: string): string {
  const map: Record<string, string> = {
    groq: 'Groq — חינמי ומהיר',
    openai: 'OpenAI — בתשלום',
  };
  return map[opt] ?? opt;
}

function SettingRowEditor({ row, onSaved }: { row: SettingRow; onSaved: (value: SettingValue) => void }) {
  const [value, setValue] = useState<SettingValue>(row.value);
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

  if (row.type === 'enum') {
    return (
      <li className="rounded-md border border-border p-3">
        <div className="text-sm font-medium">{row.description}</div>
        <div className="text-[11px] text-ink-faint mt-0.5 font-mono">{row.key}</div>
        <div className="mt-2 flex items-center gap-2">
          <Select value={String(value)} onChange={(e) => setValue(e.target.value)} className="w-60">
            {(row.options ?? []).map((o) => <option key={o} value={o}>{engineOptionLabel(o)}</option>)}
          </Select>
          <span className="text-[11px] text-ink-muted">ברירת מחדל: {engineOptionLabel(String(row.default))}</span>
          <Button size="sm" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()} className="ms-auto">שמור</Button>
        </div>
      </li>
    );
  }

  if (row.type === 'boolean') {
    const bool = value === true;
    return (
      <li className="rounded-md border border-border p-3">
        <div className="text-sm font-medium">{row.description}</div>
        <div className="text-[11px] text-ink-faint mt-0.5 font-mono">{row.key}</div>
        <div className="mt-2 flex items-center gap-2">
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={bool}
              onChange={(e) => setValue(e.target.checked)}
              className="h-4 w-4"
            />
            {bool ? 'מופעל' : 'כבוי'}
          </label>
          <Button
            size="sm"
            loading={save.isPending}
            disabled={!dirty}
            onClick={() => save.mutate()}
            className="ms-auto"
          >
            שמור
          </Button>
        </div>
      </li>
    );
  }

  if (row.type === 'string') {
    return (
      <li className="rounded-md border border-border p-3">
        <div className="text-sm font-medium">{row.description}</div>
        <div className="text-[11px] text-ink-faint mt-0.5 font-mono">{row.key}</div>
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="text"
            dir="ltr"
            value={String(value ?? '')}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0501234567"
            className="w-60"
          />
          <Button size="sm" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()} className="ms-auto">
            שמור
          </Button>
        </div>
      </li>
    );
  }

  const numValue = typeof value === 'number' ? value : Number(value);
  const min = row.min ?? 0;
  const max = row.max ?? 100;
  // Confidence-style thresholds (0–1) need decimal steps; everything else is integers.
  const step = max <= 1 ? 0.05 : 1;
  const invalid = !Number.isFinite(numValue) || numValue < min || numValue > max;

  return (
    <li className="rounded-md border border-border p-3">
      <div className="text-sm font-medium">{row.description}</div>
      <div className="text-[11px] text-ink-faint mt-0.5 font-mono">{row.key}</div>
      <div className="mt-2 flex items-center gap-2">
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(numValue) ? numValue : ''}
          onChange={(e) => setValue(Number(e.target.value))}
          className="w-32 num"
        />
        <span className="text-[11px] text-ink-muted">ברירת מחדל: {String(row.default)} · טווח: {min}–{max}</span>
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
      <ScanThresholdsCard />
      <SemanticMatchingCard />
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

function ScanThresholdsCard() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.list(),
  });
  const rows = (list.data?.data ?? []).filter(
    (r) => r.key.startsWith('matching.') && !r.key.startsWith('matching.semantic_'),
  );

  return (
    <Card>
      <CardHeader><h3 className="text-base font-semibold">ספי סריקת התאמות</h3></CardHeader>
      <CardBody>
        <div className="text-xs text-ink-muted mb-3">
          ערכים אלו שולטים בסריקה האינקרמנטלית: איזה ציון נחשב להתאמה כשירה, והאם/מתי נוצרות טיוטות הצעה אוטומטית.
        </div>
        {list.isLoading ? (
          <LoadingSkeleton rows={3} />
        ) : list.isError ? (
          <div className="text-xs text-danger">טעינת ההגדרות נכשלה</div>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
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
                }}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function SemanticMatchingCard() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.list(),
  });
  const rows = (list.data?.data ?? []).filter((r) => r.key.startsWith('matching.semantic_'));

  return (
    <Card>
      <CardHeader><h3 className="text-base font-semibold">התאמה סמנטית (וקטורים)</h3></CardHeader>
      <CardBody>
        <div className="text-xs text-ink-muted mb-3">
          תוסף אופציונלי: המערכת ממירה את הטקסטים החופשיים בפרופילים (תיאור עצמי, ציפיות, מה מחפש/ת)
          לווקטורים ומחשבת דמיון סמנטי בין מועמדים. דמיון גבוה נותן בונוס בממד הגמישות של המנוע —
          הוא <b>לא מחליף</b> את הכללים הקבועים (מגדר, גיל, מגזר). כיבוי מחזיר מיידית לניתוח
          הדטרמיניסטי בלבד; וקטורים שכבר נוצרו נשמרים לשימוש עתידי. דורש מפתח OpenAI בצד השרת.
        </div>
        {list.isLoading ? (
          <LoadingSkeleton rows={1} />
        ) : list.isError ? (
          <div className="text-xs text-danger">טעינת ההגדרות נכשלה</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-ink-muted">אין הגדרות התאמה סמנטית זמינות.</div>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
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
                }}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
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

function AiEngineSection() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.list(),
  });
  const rows = (list.data?.data ?? []).filter((r) => r.key.startsWith('ai.'));

  return (
    <Card>
      <CardHeader><h3 className="text-base font-semibold">מנוע AI</h3></CardHeader>
      <CardBody>
        <div className="text-xs text-ink-muted mb-3">
          בחירת מנוע ה-AI הראשי. <b>Groq</b> חינמי ומהיר; <b>OpenAI</b> בתשלום ויציב יותר. המנוע השני משמש כגיבוי אוטומטי אם הראשי נכשל. השינוי נכנס לתוקף מיד.
        </div>
        {list.isLoading ? (
          <LoadingSkeleton rows={1} />
        ) : list.isError ? (
          <div className="text-xs text-danger">טעינת ההגדרות נכשלה</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-ink-muted">אין הגדרות מנוע זמינות.</div>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
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
                }}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function PipelineSettingsSection() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.list(),
  });
  const rows = (list.data?.data ?? []).filter(
    (r) => r.key.startsWith('extraction.') || r.key.startsWith('learning.'),
  );

  return (
    <div className="space-y-4">
    <Card>
      <CardHeader><h3 className="text-base font-semibold">עיבוד ולמידה</h3></CardHeader>
      <CardBody>
        <div className="text-xs text-ink-muted mb-3">
          ספי החילוץ שולטים מתי מועמד נוצר אוטומטית ומתי מדלגים על ה-AI; הגדרות הלמידה שולטות ברענון התובנות מהיסטוריית ההצעות. השינוי נכנס לתוקף מיד.
        </div>
        {list.isLoading ? (
          <LoadingSkeleton rows={4} />
        ) : list.isError ? (
          <div className="text-xs text-danger">טעינת ההגדרות נכשלה</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-ink-muted">אין הגדרות עיבוד ולמידה זמינות.</div>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
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
                }}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
    <CardLabelsCard />
    </div>
  );
}

// ── Card-label dictionary (Feature C) ────────────────────
// Operator-taught "label → field" mappings the parser learns from. New rows
// are usually added straight from a review card ("למד"); this card is the full
// list to review/remove them.
const CARD_FIELD_LABELS: Record<CardLabelField, string> = {
  name: 'שם', age: 'גיל', height: 'גובה', city: 'עיר / מגורים', edah: 'עדה',
  sector: 'רמה דתית / מגזר', status: 'מצב משפחתי', occupation: 'עיסוק', about: 'על עצמו',
  family: 'משפחה', service: 'שירות צבאי/לאומי', yeshiva: 'ישיבה / השכלה', seeking: 'מה מחפש',
  ageRange: 'טווח גילאים', maxAge: 'עד גיל', photos: 'תמונות', phone: 'טלפון',
};

function CardLabelsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['card-labels'], queryFn: () => extractionApi.listCardLabels() });
  const rows = q.data?.data ?? [];
  const [labelText, setLabelText] = useState('');
  const [field, setField] = useState<CardLabelField>('name');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['card-labels'] });
  const add = useMutation({
    mutationFn: () => extractionApi.addCardLabel(labelText.trim(), field),
    onSuccess: () => { toast.success('התווית נוספה', 'תיכנס לתוקף בכרטיסים הבאים'); setLabelText(''); invalidate(); },
    onError: (e) => toast.error('ההוספה נכשלה', (e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => extractionApi.deleteCardLabel(id),
    onSuccess: () => { toast.success('התווית הוסרה'); invalidate(); },
    onError: (e) => toast.error('ההסרה נכשלה', (e as Error).message),
  });

  return (
    <Card>
      <CardHeader><h3 className="text-base font-semibold">מילון תוויות כרטיסי שידוך</h3></CardHeader>
      <CardBody>
        <div className="text-xs text-ink-muted mb-3">
          מיפוי של תווית כפי שמופיעה בכרטיס (למשל <b>כינוי</b>) לשדה מובנה. הפענוח לומד אותן וכל כרטיס
          עתידי בפורמט הזה מפוענח אוטומטית — כך התור מתקצר מעצמו. אפשר להוסיף גם ישירות מכרטיס בתור הסקירה
          (כפתור "למד").
        </div>
        <div className="flex items-end gap-2 flex-wrap mb-4">
          <div>
            <div className="text-[11px] text-ink-muted mb-0.5">תווית (כפי שמופיעה בכרטיס)</div>
            <Input value={labelText} onChange={(e) => setLabelText(e.target.value)} placeholder="כינוי" className="w-48" />
          </div>
          <div>
            <div className="text-[11px] text-ink-muted mb-0.5">ממופה לשדה</div>
            <Select value={field} onChange={(e) => setField(e.target.value as CardLabelField)} className="w-48">
              {(Object.keys(CARD_FIELD_LABELS) as CardLabelField[]).map((f) => (
                <option key={f} value={f}>{CARD_FIELD_LABELS[f]}</option>
              ))}
            </Select>
          </div>
          <Button size="sm" loading={add.isPending} disabled={!labelText.trim()} onClick={() => add.mutate()}>
            הוסף
          </Button>
        </div>

        {q.isLoading ? (
          <LoadingSkeleton rows={2} />
        ) : rows.length === 0 ? (
          <div className="text-xs text-ink-muted">עדיין לא נלמדו תוויות מותאמות. הבסיס המובנה ממשיך לעבוד כרגיל.</div>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r._id} className="flex items-center gap-2 text-sm rounded-md border border-border px-3 py-1.5">
                <span className="font-medium">{r.label}</span>
                <span className="text-ink-faint text-xs">→</span>
                <Badge tone="neutral">{CARD_FIELD_LABELS[r.field] ?? r.field}</Badge>
                <button
                  className="ms-auto text-ink-faint hover:text-danger"
                  title="הסר"
                  onClick={() => remove.mutate(r._id)}
                  disabled={remove.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function NotificationsSettingsSection() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.list(),
  });
  const rows = (list.data?.data ?? []).filter((r) => r.key.startsWith('notifications.'));

  return (
    <Card>
      <CardHeader><h3 className="text-base font-semibold">התראת התאמה למנהל</h3></CardHeader>
      <CardBody>
        <div className="text-xs text-ink-muted mb-3">
          כשמופעל: ברגע שמועמד חדש נכנס למערכת ונמצאת לו התאמה וקטורית (סמנטית) לאחד המועמדים הפנימיים,
          נשלח למספר הוואטסאפ שהוגדר כרטיס שידוכים של המועמד החדש + לינק לכרטיס במערכת, עם כותרת מודגשת
          של שם המועמד/ת שאליו נמצאה ההתאמה. דורש <b>התאמה סמנטית פעילה</b> (בכללי התאמה) וערוץ שליחה תקין.
        </div>
        {list.isLoading ? (
          <LoadingSkeleton rows={2} />
        ) : list.isError ? (
          <div className="text-xs text-danger">טעינת ההגדרות נכשלה</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-ink-muted">אין הגדרות התראה זמינות.</div>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
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
                }}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
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

