import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpRight, Lightbulb, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { aiApi } from '@/services/api/ai';
import type { AskAIResult } from '@/types/domain';
import { Drawer } from '@/components/ui/Drawer';
import { Badge, Button, Card, CardBody, Spinner, Table, TBody, Td, Textarea, Th, THead, Tabs, Tr } from '@/components/ui/primitives';
import { EmptyState } from '@/components/states/states';
import { label, matchTypeTone } from '@/utils/labels';

// ═══════════════════════════════════════════════════════════
// Ask AI panel
//
// Advisory only — displays structured results from the backend.
// Never performs actions directly. Every "action" in the results
// is a navigation link — the user chooses what to do.
// ═══════════════════════════════════════════════════════════

export function AskAIPanel({
  open,
  onClose,
  initialQuery,
  contextId,
}: {
  open: boolean;
  onClose: () => void;
  /** Optional pre-filled query text (contextual entry points) */
  initialQuery?: string;
  /**
   * Optional record id (card/match) tied to this question. Hidden from the
   * visible query — appended automatically to the text sent to the AI so the
   * user sees the word "כרטיס" instead of a raw id.
   */
  contextId?: string;
}) {
  const [query, setQuery] = useState(initialQuery ?? '');
  useEffect(() => {
    if (open && initialQuery !== undefined) setQuery(initialQuery);
  }, [open, initialQuery]);
  const ask = useMutation({
    mutationFn: (q: string) => aiApi.ask({ query: q }),
  });

  // Append the hidden context id (if any) to the visible query before sending.
  const submit = () => {
    const q = query.trim();
    if (!q) return;
    const withContext = contextId ? `${q} (מזהה כרטיס: ${contextId})` : q;
    ask.mutate(withContext);
  };

  const result = ask.data?.data;

  return (
    <Drawer
      open={open}
      onClose={() => { setQuery(''); ask.reset(); onClose(); }}
      title={<span className="inline-flex items-center gap-2"><Sparkles className="h-5 w-5 text-brand" /> Ask AI</span>}
      subtitle="שאל שאלה בשפה חופשית — המערכת תנתח ותאחזר תוצאות באמצעות כלים פנימיים בלבד."
      width="lg"
      footer={
        <div className="flex items-center justify-between">
          <div className="text-xs text-ink-faint">
            ⓘ Ask AI מייעץ בלבד — לא מבצע פעולות.
          </div>
          <Button
            onClick={submit}
            loading={ask.isPending}
            disabled={!query.trim()}
            leftIcon={<Sparkles className="h-4 w-4" />}
          >
            שאל
          </Button>
        </div>
      }
    >
      <div className="p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-ink mb-1.5">שאלה</label>
          <Textarea
            rows={3}
            placeholder='לדוגמה: "מי ההתאמות הטובות ביותר למועמד 67a1...?" או "איזה חיצוניים התיישנו?"'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {ask.isPending && (
          <div className="flex items-center gap-2 text-sm text-ink-muted">
            <Spinner className="h-4 w-4" /> מנתח את השאלה ומריץ כלים...
          </div>
        )}

        {ask.isError && (
          <Card>
            <CardBody className="text-sm text-danger flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              שאילתת Ask AI נכשלה: {(ask.error as Error).message}
            </CardBody>
          </Card>
        )}

        {result && <AskAIResults result={result} />}

        {!ask.isPending && !result && !ask.isError && (
          <EmptyState
            icon={<Lightbulb className="h-10 w-10 text-ink-faint" />}
            title="שאלות שימושיות"
            description='נסה: "מועמדים שלא טופלו החודש" · "התאמות בסיכון גבוה השבוע" · "סיכום של מועמד X"'
          />
        )}
      </div>
    </Drawer>
  );
}

// Hebrew labels for the detected Ask AI intent (the engine returns enum codes).
const INTENT_LABELS_HE: Record<string, string> = {
  find_matching_candidates: 'חיפוש התאמות',
  find_unhandled_candidates: 'כרטיסים שלא טופלו',
  find_high_potential_matches: 'התאמות בעלות פוטנציאל גבוה',
  find_stale_candidates: 'כרטיסים שהתיישנו',
  find_similar_candidates: 'כרטיסים דומים',
  find_active_issues: 'נושאים הדורשים טיפול',
  summarize_candidate: 'סיכום כרטיס',
  unknown: 'כוונה לא ברורה',
};

export function AskAIResults({ result }: { result: AskAIResult }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-ink-muted uppercase tracking-wide">
            כוונה שזוהתה
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="brand">{INTENT_LABELS_HE[result.intent] ?? result.intent}</Badge>
            {Object.entries(result.appliedFilters).slice(0, 6).map(([k, v]) => (
              <Badge key={k} tone="neutral">{k}: {String(v)}</Badge>
            ))}
          </div>
          {result.reasoningSummary && (
            <p className="text-sm text-ink mt-2">{result.reasoningSummary}</p>
          )}
        </CardBody>
      </Card>

      {result.warnings.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardBody>
            <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide mb-2 inline-flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4" /> אזהרות
            </div>
            <ul className="text-sm text-amber-900 space-y-1 list-disc ps-4">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody>
          <div className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
            תוצאות ({result.results.length})
          </div>
          {result.results.length === 0 ? (
            <div className="text-sm text-ink-muted">לא נמצאו תוצאות.</div>
          ) : result.results.every(isMatchRow) ? (
            <MatchResultsTabs rows={result.results.filter(isMatchRow)} />
          ) : (
            <ul className="space-y-2">
              {result.results.slice(0, 10).map((r, i) => (
                <ResultRow key={i} raw={r} />
              ))}
              {result.results.length > 10 && (
                <li className="text-xs text-ink-faint">+{result.results.length - 10} נוספות</li>
              )}
            </ul>
          )}
        </CardBody>
      </Card>

      {result.recommendedActions.length > 0 && (
        <Card>
          <CardBody>
            <div className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
              המלצות
            </div>
            <ul className="text-sm text-ink space-y-1 list-disc ps-4">
              {result.recommendedActions.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

// ── Match-result rendering (find_matching_candidates) ──────
//
// The server enriches engine results with the external's identity
// (MatchingCandidateRow). When ALL results carry that shape we render
// score-bucket tabs — mirroring the pipeline's score filter (80+/60+/40+)
// — with a person-facing table instead of the generic key:value list.

interface MatchRowLike {
  externalCandidateId: string;
  firstName?: string;
  lastName?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  matchScore: number;
  confidenceScore?: number;
  matchType?: string;
  riskLevel?: string;
  eligible?: boolean;
}

function isMatchRow(r: unknown): r is MatchRowLike {
  const o = r as Record<string, unknown> | null;
  return !!o && typeof o['externalCandidateId'] === 'string' && typeof o['matchScore'] === 'number';
}

const SCORE_BUCKETS: Array<{
  id: string;
  labelText: string;
  min: number;
  max: number;
  tone: 'success' | 'brand' | 'warning' | 'neutral';
}> = [
  { id: 'high',   labelText: '80+',    min: 80, max: 100, tone: 'success' },
  { id: 'medium', labelText: '60–79',  min: 60, max: 79,  tone: 'brand' },
  { id: 'low',    labelText: '40–59',  min: 40, max: 59,  tone: 'warning' },
  { id: 'rest',   labelText: 'מתחת ל-40', min: 0, max: 39, tone: 'neutral' },
];

export function MatchResultsTabs({ rows }: { rows: MatchRowLike[] }) {
  const buckets = SCORE_BUCKETS.map((b) => ({
    bucket: b,
    items: rows.filter((r) => r.matchScore >= b.min && r.matchScore <= b.max),
  }));
  const initialId = buckets.find((b) => b.items.length > 0)?.bucket.id;

  return (
    <Tabs
      initialId={initialId}
      tabs={buckets.map(({ bucket, items }) => ({
        id: bucket.id,
        label: `ציון ${bucket.labelText}`,
        badge: <Badge tone={items.length ? bucket.tone : 'neutral'}>{items.length}</Badge>,
        content: items.length === 0 ? (
          <div className="text-sm text-ink-muted py-4 text-center">אין מועמדים בטווח ציונים זה.</div>
        ) : (
          <MatchRowsTable items={items} />
        ),
      }))}
    />
  );
}

function MatchRowsTable({ items }: { items: MatchRowLike[] }) {
  return (
    <Table>
      <THead>
        <Tr>
          <Th>מועמד/ת</Th><Th>גיל</Th><Th>עיר</Th><Th>סוג</Th><Th>ציון</Th><Th>ביטחון</Th><Th></Th>
        </Tr>
      </THead>
      <TBody>
        {items.map((r) => {
          const name = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || r.externalCandidateId.slice(-8);
          return (
            <Tr key={r.externalCandidateId}>
              <Td>
                <Link
                  to={`/candidates/external/${r.externalCandidateId}`}
                  className="text-sm font-medium text-ink hover:underline"
                >
                  {name}
                </Link>
              </Td>
              <Td className="num">{r.age ?? '—'}</Td>
              <Td>{r.city ?? '—'}</Td>
              <Td>
                {r.matchType
                  ? <Badge tone={matchTypeTone(r.matchType)}>{label('matchType', r.matchType)}</Badge>
                  : '—'}
              </Td>
              <Td className="num font-semibold">{r.matchScore}</Td>
              <Td className="num">{r.confidenceScore ?? '—'}</Td>
              <Td className="text-end">
                <Link
                  to={`/candidates/external/${r.externalCandidateId}`}
                  className="text-xs text-brand-700 inline-flex items-center gap-1 hover:underline"
                >
                  פתח <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
}

function ResultRow({ raw }: { raw: unknown }) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const title: string = (typeof r['firstName'] === 'string' && `${r['firstName']} ${r['lastName'] ?? ''}`)
    || (typeof r['title'] === 'string' ? r['title'] : '')
    || (typeof r['id'] === 'string' ? r['id'] : '')
    || 'תוצאה';

  // Heuristic navigation — if it looks like a candidate/match id, link to the detail
  let to: string | null = null;
  if (r['internalCandidateId']) to = `/matches/${r['_id']}`;
  else if (r['_id'] && r['sectorGroup']) to = `/candidates/internal/${r['_id']}`;
  else if (r['_id']) to = `/candidates/external/${r['_id']}`;

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink truncate">{title}</div>
        <div className="text-xs text-ink-muted truncate">
          {Object.entries(r).filter(([k]) => !['_id', 'firstName', 'lastName'].includes(k)).slice(0, 3)
            .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`).join(' · ')}
        </div>
      </div>
      {to && (
        <Link to={to} className="text-xs text-brand-700 inline-flex items-center gap-1 hover:underline shrink-0">
          פתח <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </li>
  );
}
