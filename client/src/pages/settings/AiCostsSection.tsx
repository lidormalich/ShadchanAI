// ═══════════════════════════════════════════════════════════
// AI costs panel — admin-only report from /monitoring/ai-usage.
// Summary cards, per-model / per-request-type tables, per-day
// CSS bars. No chart library.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Card, CardBody, CardHeader, Table, TBody, Td, Th, THead, Tr } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { monitoringApi, type AiUsageBucket, type AiUsageReport } from '@/services/api/monitoring';
import { ApiError } from '@/types/api';

const PERIODS = [7, 30, 90] as const;

const REQUEST_TYPE_LABELS: Record<string, string> = {
  explain_match: 'הסבר התאמה',
  classify: 'סיווג/חילוץ',
  draft: 'ניסוח הודעות',
  summarize: 'סיכום/למידה',
  embed: 'אמבדינגים',
  ask: 'שאל את ה-AI',
};

function requestTypeLabel(t: string): string {
  return REQUEST_TYPE_LABELS[t] ?? t;
}

const nf = new Intl.NumberFormat('he-IL');

function formatCost(usd: number, requests: number): string {
  if (requests > 0 && usd < 0.01) return '< $0.01';
  return `$${usd.toFixed(2)}`;
}

function formatTokens(bucket: Pick<AiUsageBucket, 'inputTokens' | 'outputTokens'>): string {
  return nf.format(bucket.inputTokens + bucket.outputTokens);
}

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.status === 401);
}

export function AiCostsSection() {
  const [days, setDays] = useState<number>(30);

  const report = useQuery({
    queryKey: ['monitoring', 'ai-usage', days],
    queryFn: () => monitoringApi.aiUsage(days),
    retry: (failureCount, err) => !isForbidden(err) && failureCount < 2,
  });

  return (
    <Card>
      <CardHeader
        actions={
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setDays(p)}
                className={clsx(
                  'px-3 py-1.5 text-xs transition-colors',
                  days === p ? 'bg-brand-50 text-brand-700 font-semibold' : 'text-ink-muted hover:bg-bg-hover',
                )}
              >
                {p} ימים
              </button>
            ))}
          </div>
        }
      >
        <h3 className="text-base font-semibold">עלויות AI</h3>
      </CardHeader>
      <CardBody>
        {report.isLoading ? (
          <LoadingSkeleton rows={6} />
        ) : report.isError ? (
          isForbidden(report.error) ? (
            <EmptyState
              icon={<ShieldAlert className="h-10 w-10 text-ink-faint" />}
              title="זמין למנהלים בלבד"
              description="דוח עלויות ה-AI נגיש רק למשתמשים עם הרשאת מנהל."
            />
          ) : (
            <ErrorState
              title="טעינת דוח העלויות נכשלה"
              description={(report.error as Error).message}
              onRetry={() => report.refetch()}
            />
          )
        ) : report.data ? (
          <AiCostsReport report={report.data.data} />
        ) : null}
      </CardBody>
    </Card>
  );
}

function AiCostsReport({ report }: { report: AiUsageReport }) {
  const { totals, budget } = report;
  const hasUnpriced =
    totals.unpricedRequests > 0 ||
    report.byModel.some((m) => m.unpricedRequests > 0) ||
    report.byRequestType.some((t) => t.unpricedRequests > 0);

  return (
    <div className="space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCard
          label='סה"כ עלות משוערת'
          value={formatCost(totals.estCostUsd, totals.requests)}
          sub={`ב-${report.days} הימים האחרונים`}
        />
        <SummaryCard
          label="בקשות"
          value={nf.format(totals.requests)}
          sub={totals.failures > 0 ? `מתוכן ${nf.format(totals.failures)} כשלונות` : 'ללא כשלונות'}
        />
        <SummaryCard
          label="טוקנים"
          value={formatTokens(totals)}
          sub={`קלט ${nf.format(totals.inputTokens)} · פלט ${nf.format(totals.outputTokens)}`}
        />
        <SummaryCard
          label="תקציב יומי"
          value={budget.limit === 0 ? 'ללא הגבלה' : `${nf.format(budget.usedToday)} / ${nf.format(budget.limit)}`}
          sub={budget.limit === 0 ? `נוצלו היום: ${nf.format(budget.usedToday)}` : `נכון ל-${budget.day}`}
        />
      </div>

      {hasUnpriced && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>חלק מהבקשות ממודלים ללא תמחור ידוע — העלות בפועל גבוהה מההערכה.</span>
        </div>
      )}

      {/* Per-day bars */}
      <div>
        <h4 className="text-sm font-semibold mb-2">עלות לפי יום</h4>
        {report.byDay.length === 0 ? (
          <div className="text-xs text-ink-muted">אין נתונים לתקופה שנבחרה.</div>
        ) : (
          <DayBars byDay={report.byDay} />
        )}
      </div>

      {/* By model */}
      <div>
        <h4 className="text-sm font-semibold mb-2">לפי מודל</h4>
        {report.byModel.length === 0 ? (
          <div className="text-xs text-ink-muted">אין בקשות בתקופה שנבחרה.</div>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>ספק</Th>
                <Th>מודל</Th>
                <Th>בקשות</Th>
                <Th>טוקנים (קלט / פלט)</Th>
                <Th>עלות משוערת</Th>
              </tr>
            </THead>
            <TBody>
              {report.byModel.map((m) => (
                <Tr key={`${m.provider}:${m.model}`}>
                  <Td className="text-ink-muted">{m.provider}</Td>
                  <Td className="font-mono text-xs">{m.model}</Td>
                  <Td className="num">{nf.format(m.requests)}</Td>
                  <Td className="num text-xs">
                    {nf.format(m.inputTokens)} / {nf.format(m.outputTokens)}
                  </Td>
                  <Td className="num">{formatCost(m.estCostUsd, m.requests)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      {/* By request type */}
      <div>
        <h4 className="text-sm font-semibold mb-2">לפי סוג בקשה</h4>
        {report.byRequestType.length === 0 ? (
          <div className="text-xs text-ink-muted">אין בקשות בתקופה שנבחרה.</div>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>סוג בקשה</Th>
                <Th>בקשות</Th>
                <Th>עלות משוערת</Th>
              </tr>
            </THead>
            <TBody>
              {report.byRequestType.map((t) => (
                <Tr key={t.requestType}>
                  <Td>{requestTypeLabel(t.requestType)}</Td>
                  <Td className="num">{nf.format(t.requests)}</Td>
                  <Td className="num">{formatCost(t.estCostUsd, t.requests)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      <p className="text-[11px] text-ink-faint border-t border-border pt-3">
        הערכה לפי מחירון רשמי × טוקנים שנרשמו; החיוב בפועל אצל הספק.
      </p>
    </div>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold num" dir="ltr">
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}

function DayBars({ byDay }: { byDay: AiUsageReport['byDay'] }) {
  const maxCost = Math.max(...byDay.map((d) => d.estCostUsd), 0);
  return (
    <ul className="space-y-1">
      {byDay.map((d) => {
        const pct = maxCost > 0 ? Math.max((d.estCostUsd / maxCost) * 100, d.requests > 0 ? 2 : 0) : 0;
        return (
          <li
            key={d.day}
            className="flex items-center gap-2"
            title={`${d.day} · ${nf.format(d.requests)} בקשות (${nf.format(d.failures)} כשלונות) · ${nf.format(d.inputTokens)} טוקני קלט · ${nf.format(d.outputTokens)} טוקני פלט · $${d.estCostUsd.toFixed(4)}`}
          >
            <span className="w-24 shrink-0 text-[11px] text-ink-muted num" dir="ltr">
              {d.day}
            </span>
            <span className="flex-1 h-3 bg-bg-subtle rounded-sm overflow-hidden">
              <span className="block h-full bg-brand rounded-sm" style={{ width: `${pct}%` }} />
            </span>
            <span className="w-16 shrink-0 text-end text-[11px] text-ink-muted num" dir="ltr">
              {formatCost(d.estCostUsd, d.requests)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
