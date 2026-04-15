import { clsx } from 'clsx';
import { ChevronLeft, FileText, Plug, ScrollText, Shield, Sliders, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { Badge, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { EmptyState } from '@/components/states/states';

interface Section {
  id: string;
  label: string;
  icon: ReactNode;
  content: ReactNode;
}

function SectionsList(): Section[] {
  return [
    { id: 'matching',   label: 'כללי התאמה',  icon: <Sliders className="h-4 w-4" />,    content: <MatchingRulesSection /> },
    { id: 'templates',  label: 'תבניות',      icon: <FileText className="h-4 w-4" />,   content: <TemplatesSection /> },
    { id: 'channels',   label: 'ערוצים',      icon: <Plug className="h-4 w-4" />,       content: <ChannelsSettingsSection /> },
    { id: 'team',       label: 'צוות והרשאות', icon: <Users className="h-4 w-4" />,     content: <TeamSection /> },
    { id: 'audit',      label: 'יומן ביקורת', icon: <ScrollText className="h-4 w-4" />, content: <AuditSection /> },
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

function TemplatesSection() {
  return (
    <Card>
      <CardHeader><h3 className="text-base font-semibold">תבניות הודעות</h3></CardHeader>
      <CardBody>
        <EmptyState
          title="ניהול תבניות יתווסף בעתיד"
          description="תבניות הודעות פתיחה, מעקב וסירוב יטופלו במסך ייעודי כאשר זרימת שליחת ההצעות תופעל."
        />
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

function TeamSection() {
  return (
    <Card>
      <CardHeader><h3 className="text-base font-semibold">צוות והרשאות</h3></CardHeader>
      <CardBody>
        <EmptyState
          title="ניהול משתמשים יתווסף בעתיד"
          description="משתמשים, תפקידים (admin · shadchan · viewer) והרשאות יוגדרו כאן לאחר הוספת מודל משתמשים בשרת."
        />
      </CardBody>
    </Card>
  );
}

function AuditSection() {
  return (
    <Card>
      <CardHeader><h3 className="text-base font-semibold">יומן ביקורת</h3></CardHeader>
      <CardBody>
        <EmptyState
          title="יומן פעולות"
          description="כל פעולה משמעותית במערכת נרשמת ביומן ביקורת בלתי ניתן לשינוי. תצוגה בממשק תתווסף בשלב הבא."
        />
      </CardBody>
    </Card>
  );
}
