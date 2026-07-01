// ═══════════════════════════════════════════════════════════
// Insights (Phase 5 — honest-only rebuild).
//
// Every number on this page is backed by /api/insights/summary,
// which is aggregated directly from real collections. There is
// no fake chart, no placeholder shadchan performance section.
// When we have real per-shadchan analytics, they can be added
// here without having to remove anything fake first.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckSquare, Heart, Inbox, Send, Users2, UserCheck, ShieldAlert } from 'lucide-react';
import { KpiCard } from '@/components/domain/KpiCard';
import { Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { LoadingSkeleton } from '@/components/states/states';
import { insightsApi, type GenderBreakdown, type GenderSuspect } from '@/services/api/insights';

const genderHe = (g: 'male' | 'female') => (g === 'male' ? 'בן' : 'בת');

// One row of the gender-breakdown card: זכר / נקבה / לא ידוע for a pool.
// "לא ידוע" is highlighted when > 0 and links to that pool's list filtered
// to the missing-gender rows — those candidates never appear in matching.
function GenderRow({ label, data, missingHref }: { label: string; data?: GenderBreakdown; missingHref: string }) {
  const total = data ? data.male + data.female + data.unknown : 0;
  const unknown = data?.unknown ?? 0;
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-0">
      <div className="text-sm text-ink">
        {label}
        <span className="text-ink-muted text-xs"> · {total} פעילים</span>
      </div>
      <div className="flex items-center gap-4 text-sm num">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-brand" />
          <span className="text-ink-muted text-xs">זכר</span> {data?.male ?? '—'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-pink-500" />
          <span className="text-ink-muted text-xs">נקבה</span> {data?.female ?? '—'}
        </span>
        {unknown > 0 ? (
          <Link
            to={missingHref}
            className="inline-flex items-center gap-1.5 text-danger font-semibold hover:underline"
            title="מגדר לא ידוע — לחצו לרשימת המועמדים לתיקון"
          >
            <span className="h-2.5 w-2.5 rounded-full bg-danger" />
            <span className="text-xs">לא ידוע</span> {unknown}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-ink-muted">
            <span className="h-2.5 w-2.5 rounded-full bg-border" />
            <span className="text-xs">לא ידוע</span> {data ? 0 : '—'}
          </span>
        )}
      </div>
    </div>
  );
}

// One flagged candidate whose stored gender contradicts the text of their
// own profile — the likely cause of a same-gender suggestion.
function SuspectRow({ s }: { s: GenderSuspect }) {
  return (
    <div className="py-2 border-b border-border last:border-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="font-medium text-ink">{s.name}</span>
          <span className="text-xs text-ink-muted">
            {' '}· תויג <b className="text-ink">{genderHe(s.storedGender)}</b> · לפי הטקסט נראה{' '}
            <b className="text-danger">{genderHe(s.inferredGender)}</b>
          </span>
        </div>
        <Link to={`/candidates/external/${s.id}`} className="text-xs text-brand-700 hover:underline whitespace-nowrap">
          פתח ותקן
        </Link>
      </div>
      {s.snippet && <p className="text-xs text-ink-faint truncate mt-0.5">{s.snippet}</p>}
    </div>
  );
}

export function InsightsPage() {
  const q = useQuery({
    queryKey: ['insights', 'summary'],
    queryFn: () => insightsApi.summary(),
    staleTime: 60_000,
  });

  const gq = useQuery({
    queryKey: ['insights', 'gender-quality'],
    queryFn: () => insightsApi.genderQuality(),
    staleTime: 60_000,
  });

  const c = q.data?.data.counters;
  const gender = q.data?.data.gender;
  const suspects = gq.data?.data.suspects ?? [];
  const funnel = q.data?.data.funnel ?? [];
  const funnelMax = Math.max(1, ...funnel.map((f) => f.count));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">תובנות תפעוליות</h2>
        <p className="text-sm text-ink-muted">נתונים אמיתיים בלבד — מצטברים מהמערכת החיה.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard label="פעילים" value={c?.activeInternals ?? '—'} icon={<Users2 className="h-5 w-5" />} />
        <KpiCard label="בהיכרות" value={c?.datingInternals ?? '—'} icon={<Heart className="h-5 w-5" />} tone="good" />
        <KpiCard label="חיצוניים פעילים" value={c?.activeExternals ?? '—'} icon={<UserCheck className="h-5 w-5" />} />
        <KpiCard label="נשלחו השבוע" value={c?.sentThisWeek ?? '—'} icon={<Send className="h-5 w-5" />} />
        <KpiCard label="משימות פתוחות" value={c?.openTasks ?? '—'} icon={<CheckSquare className="h-5 w-5" />} />
        <KpiCard label="דורש סקירה" value={c?.needsReview ?? '—'} icon={<Inbox className="h-5 w-5" />} tone={c?.needsReview ? 'bad' : undefined} />
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold inline-flex items-center gap-2">
            <Users2 className="h-4 w-4" /> פילוח מגדר במאגרים
          </h3>
        </CardHeader>
        <CardBody>
          {q.isLoading ? (
            <LoadingSkeleton rows={2} />
          ) : (
            <>
              <GenderRow label="מאגר פרטי (פנימי)" data={gender?.internal} missingHref="/candidates/internal?gender=missing" />
              <GenderRow label="מאגר כללי (חיצוני)" data={gender?.external} missingHref="/candidates/external?gender=missing" />
              {(gender?.internal.unknown || gender?.external.unknown) ? (
                <p className="text-xs text-danger mt-2 inline-flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  יש מועמדים ללא מגדר — השלמת המגדר תמנע הצעות שגויות (כמו שני מועמדים מאותו מין).
                </p>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>

      {(gq.isLoading || suspects.length > 0) && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold inline-flex items-center gap-2 text-danger">
              <ShieldAlert className="h-4 w-4" /> מגדר חשוד — ייתכן תיוג שגוי
              {suspects.length > 0 && <span className="num">({suspects.length})</span>}
            </h3>
          </CardHeader>
          <CardBody>
            {gq.isLoading ? (
              <LoadingSkeleton rows={2} />
            ) : (
              <>
                <p className="text-xs text-ink-muted mb-2">
                  מועמדים חיצוניים שהמגדר המתויג שלהם סותר את הטקסט בפרופיל — הסיבה הסבירה להצעה של שני מועמדים מאותו מין.
                  בדקו ותקנו את המגדר.
                </p>
                {suspects.map((s) => <SuspectRow key={s.id} s={s} />)}
                {gq.data?.data.capped && (
                  <p className="text-xs text-ink-faint mt-2">
                    נסרקו {gq.data.data.scanned} מועמדים בלבד (תקרה) — ייתכנו נוספים.
                  </p>
                )}
              </>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold inline-flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> משפך הצעות
          </h3>
        </CardHeader>
        <CardBody>
          {q.isLoading ? (
            <LoadingSkeleton rows={5} />
          ) : (
            <div className="space-y-2">
              {funnel.map((f) => (
                <div key={f.key} className="flex items-center gap-3">
                  <div className="w-24 text-xs text-ink-muted">{f.label}</div>
                  <div className="flex-1 h-2 bg-bg-subtle rounded-full overflow-hidden">
                    <div
                      className="bg-brand h-full rounded-full transition-all"
                      style={{ width: `${Math.round((f.count / funnelMax) * 100)}%` }}
                    />
                  </div>
                  <div className="w-10 text-xs num text-end text-ink">{f.count}</div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
