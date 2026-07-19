// ═══════════════════════════════════════════════════════════
// CompatibilityWorkspace — operator's main matching screen for a
// single internal candidate.
//
// Layout:
//   - Top bar: bucket counters + refresh + manual pair-check entry
//   - Sub-tabs: Suitable | Weak | Forced | Blocked | Historical
//   - Per row: deterministic explanation + manual review overlay +
//              per-row actions (mark, force, AI explain, drill in)
//
// All explanations come from the deterministic engine. AI commentary
// is fetched on demand and labeled clearly as advisory.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Filter,
  History,
  Lock,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Target,
} from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Select,
  Tabs,
  Textarea,
} from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { CandidatePicker } from '@/components/ui/CandidatePicker';
import { externalToOption } from '@/features/candidates/candidateOptions';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { label } from '@/utils/labels';
import {
  compatibilityApi,
  pairReviewsApi,
  semanticApi,
  type CompatibilityBoard,
  type CompatibilityBucket,
  type CompatibilityRow,
  type PairCheckResult,
  type PairReviewStatus,
  type SemanticMatchRow,
} from '@/services/api/pair-reviews';
import { matchesApi } from '@/services/api/matches';
import { externalCandidatesApi } from '@/services/api/candidates';
import type { ExternalCandidate } from '@/types/domain';

const BUCKET_LABEL: Record<CompatibilityBucket, string> = {
  suitable: 'מתאימים',
  weak: 'חלשים / אזהרה',
  blocked: 'חסומים',
  forced: 'כפויים',
  historical: 'היסטוריה',
};

const BUCKET_ICON: Record<CompatibilityBucket, JSX.Element> = {
  suitable: <CheckCircle2 className="h-4 w-4" />,
  weak: <AlertTriangle className="h-4 w-4" />,
  blocked: <Lock className="h-4 w-4" />,
  forced: <ShieldAlert className="h-4 w-4" />,
  historical: <History className="h-4 w-4" />,
};

const BUCKET_TONE: Record<CompatibilityBucket, 'success' | 'warning' | 'danger' | 'purple' | 'neutral'> = {
  suitable: 'success',
  weak: 'warning',
  blocked: 'danger',
  forced: 'purple',
  historical: 'neutral',
};

const MANUAL_STATUS_LABEL: Record<PairReviewStatus, string> = {
  suitable: 'מתאים',
  not_suitable: 'לא מתאים',
  review_later: 'לבדוק מאוחר',
  forced: 'כפוי',
  rejected_after_contact: 'נכשל לאחר קשר',
};

const MANUAL_STATUS_TONE: Record<PairReviewStatus, 'success' | 'danger' | 'warning' | 'purple' | 'neutral'> = {
  suitable: 'success',
  not_suitable: 'danger',
  review_later: 'warning',
  forced: 'purple',
  rejected_after_contact: 'danger',
};

export function CompatibilityWorkspace({ internalCandidateId }: { internalCandidateId: string }) {
  const qc = useQueryClient();
  const [reviewTarget, setReviewTarget] = useState<CompatibilityRow | null>(null);
  const [forceTarget, setForceTarget] = useState<CompatibilityRow | null>(null);
  const [drilldownTarget, setDrilldownTarget] = useState<CompatibilityRow | null>(null);
  const [pairCheckOpen, setPairCheckOpen] = useState(false);

  const board = useQuery({
    queryKey: ['compatibility-board', internalCandidateId],
    queryFn: () => compatibilityApi.board(internalCandidateId, { mode: 'strict' }),
  });

  // Semantic matches — shared cache key with the tab content, so this
  // top-level fetch also feeds the tab badge.
  const semantic = useQuery({
    queryKey: ['semantic-matches', internalCandidateId],
    queryFn: () => semanticApi.matches(internalCandidateId),
  });

  const refetch = () => board.refetch();

  if (board.isLoading) return <LoadingSkeleton rows={8} />;
  if (board.isError) {
    return (
      <ErrorState
        description={(board.error as Error).message}
        onRetry={() => board.refetch()}
      />
    );
  }
  if (!board.data) return null;

  const data = board.data.data;

  return (
    <div className="space-y-4">
      <BoardHeader
        board={data}
        onRefresh={refetch}
        refreshing={board.isFetching}
        onPairCheck={() => setPairCheckOpen(true)}
      />

      <Tabs
        tabs={[
          ...(['suitable', 'weak', 'forced', 'blocked', 'historical'] as CompatibilityBucket[]).map((b) => ({
            id: b,
            label: (
              <span className="inline-flex items-center gap-1.5">
                {BUCKET_ICON[b]}
                {BUCKET_LABEL[b]}
              </span>
            ),
            badge: <Badge tone={BUCKET_TONE[b]}>{data.totals[b]}</Badge>,
            content: (
              <BucketSection
                bucket={b}
                rows={data.rows.filter((r) => r.bucket === b)}
                onMark={setReviewTarget}
                onForce={setForceTarget}
                onDrilldown={setDrilldownTarget}
                internalCandidateId={internalCandidateId}
              />
            ),
          })),
          {
            id: 'semantic',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="h-4 w-4" />
                הצעה חכמה
              </span>
            ),
            badge: semantic.data?.data.enabled
              ? <Badge tone="purple">{semantic.data.data.rows.length}</Badge>
              : undefined,
            content: <SemanticMatchesSection internalCandidateId={internalCandidateId} />,
          },
        ]}
      />

      {reviewTarget && (
        <ManualReviewDialog
          internalCandidateId={internalCandidateId}
          row={reviewTarget}
          onClose={() => {
            setReviewTarget(null);
            qc.invalidateQueries({ queryKey: ['compatibility-board', internalCandidateId] });
          }}
        />
      )}

      {forceTarget && (
        <ForceMatchDialog
          internalCandidateId={internalCandidateId}
          row={forceTarget}
          onClose={() => {
            setForceTarget(null);
            qc.invalidateQueries({ queryKey: ['compatibility-board', internalCandidateId] });
          }}
        />
      )}

      {drilldownTarget && (
        <PairDrilldownDialog
          internalCandidateId={internalCandidateId}
          row={drilldownTarget}
          onClose={() => setDrilldownTarget(null)}
          onMark={() => {
            setReviewTarget(drilldownTarget);
            setDrilldownTarget(null);
          }}
          onForce={() => {
            setForceTarget(drilldownTarget);
            setDrilldownTarget(null);
          }}
        />
      )}

      {pairCheckOpen && (
        <PairCheckDialog
          internalCandidateId={internalCandidateId}
          onClose={() => {
            setPairCheckOpen(false);
            qc.invalidateQueries({ queryKey: ['compatibility-board', internalCandidateId] });
          }}
        />
      )}
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────

function BoardHeader({
  board,
  onRefresh,
  refreshing,
  onPairCheck,
}: {
  board: CompatibilityBoard;
  onRefresh: () => void;
  refreshing: boolean;
  onPairCheck: () => void;
}) {
  return (
    <Card>
      <CardBody className="flex items-center gap-3 flex-wrap">
        <Target className="h-5 w-5 text-brand-700" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold">לוח התאמה</h3>
          <div className="text-xs text-ink-muted">
            {board.externalsConsidered} מועמדים נסקרו · עודכן {new Date(board.generatedAt).toLocaleString('he-IL')}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Search className="h-3.5 w-3.5" />}
          onClick={onPairCheck}
        >
          בדיקה ידנית של זוג
        </Button>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={onRefresh}
          loading={refreshing}
        >
          רענון
        </Button>
      </CardBody>
    </Card>
  );
}

// ── Bucket section ──────────────────────────────────────────

function BucketSection({
  bucket,
  rows,
  onMark,
  onForce,
  onDrilldown,
  internalCandidateId,
}: {
  bucket: CompatibilityBucket;
  rows: CompatibilityRow[];
  onMark: (row: CompatibilityRow) => void;
  onForce: (row: CompatibilityRow) => void;
  onDrilldown: (row: CompatibilityRow) => void;
  internalCandidateId: string;
}) {
  if (rows.length === 0) {
    return (
      <Card className="p-6">
        <EmptyState
          title={`אין מועמדים בקטגוריה "${BUCKET_LABEL[bucket]}"`}
          description={emptyHint(bucket)}
        />
      </Card>
    );
  }
  return (
    <Card>
      <CardBody className="!p-0">
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <CompatibilityRowItem
              key={row.externalCandidateId}
              row={row}
              onMark={onMark}
              onForce={onForce}
              onDrilldown={onDrilldown}
              internalCandidateId={internalCandidateId}
            />
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function emptyHint(b: CompatibilityBucket): string {
  switch (b) {
    case 'suitable':   return 'כשיתעדכנו פרופילים זמינים, הם יסווגו לכאן.';
    case 'weak':       return 'אין מועמדים עם ציון נמוך כעת.';
    case 'blocked':    return 'אין חסימות מנוע על המועמדים הזמינים.';
    case 'forced':     return 'אין הצעות כפויות פעילות.';
    case 'historical': return 'אין הצעות בעבר עבור מועמד זה.';
  }
}

// ── Semantic matches tab ("הצעה חכמה") ──────────────────────
//
// Pure vector ranking — independent of the deterministic engine.
// Includes the on-demand embeddings backfill ("סרוק עכשיו") with the
// same 1s polling pattern MatchScanBar uses for the bulk scan.
// Exported: also hosted standalone by pages/matches/SmartMatchesPage.

export function SemanticMatchesSection({ internalCandidateId }: { internalCandidateId: string }) {
  const qc = useQueryClient();

  // limit=200 (server max) so the score-bucket tabs have real depth —
  // with the default 50 the lower buckets would almost always be empty.
  const matches = useQuery({
    queryKey: ['semantic-matches', internalCandidateId],
    queryFn: () => semanticApi.matches(internalCandidateId, { limit: 200 }),
  });

  const backfill = useQuery({
    queryKey: ['semantic-backfill'],
    queryFn: () => semanticApi.backfillState(),
    refetchInterval: (q) => (q.state.data?.data?.status === 'running' ? 1000 : false),
  });

  // Result filters — religious/background stay OUT of the vector by
  // design (operator decision), so they're offered here as post-rank
  // narrowing instead: the similarity order is untouched, rows just
  // drop out of view.
  const [filterSector, setFilterSector] = useState('');
  const [filterCity, setFilterCity] = useState('');
  const [ageMin, setAgeMin] = useState('');
  const [ageMax, setAgeMax] = useState('');
  const filtersActive = Boolean(filterSector || filterCity || ageMin || ageMax);

  const startBackfill = useMutation({
    mutationFn: (opts: { force?: boolean } = {}) => semanticApi.backfillStart(opts),
    onSuccess: (_r, opts) => {
      toast.success(opts.force ? 'סריקה מאולצת התחילה — עוברת על כל המועמדים' : 'סריקת ההטמעות התחילה');
      void qc.invalidateQueries({ queryKey: ['semantic-backfill'] });
    },
    onError: (e) => toast.error('הפעלת הסריקה נכשלה', (e as Error).message),
  });

  const bf = backfill.data?.data;
  const running = bf?.status === 'running';

  // On running → done transition, refresh the ranked list.
  const prevStatus = useRef<string | undefined>(bf?.status);
  useEffect(() => {
    if (prevStatus.current === 'running' && bf?.status === 'done') {
      const noContent = bf.noContent ?? 0;
      toast.success(
        'הסריקה הושלמה',
        `${bf.embedded} מועמדים הוטמעו` + (noContent > 0 ? ` · ${noContent} ללא תוכן להטמעה (פרופיל ריק)` : ''),
      );
      void qc.invalidateQueries({ queryKey: ['semantic-matches'] });
    }
    prevStatus.current = bf?.status;
  }, [bf?.status, bf?.embedded, bf?.noContent, qc]);

  if (matches.isLoading) return <LoadingSkeleton rows={6} />;
  if (matches.isError) {
    return (
      <ErrorState
        description={(matches.error as Error).message}
        onRetry={() => matches.refetch()}
      />
    );
  }
  const data = matches.data?.data;
  if (!data) return null;

  if (!data.enabled) {
    return (
      <Card className="p-6">
        <EmptyState
          title="התאמה סמנטית כבויה"
          description="הפעל את המתג 'התאמה סמנטית (וקטורים)' כדי לדרג מועמדים לפי דמיון בטקסטים החופשיים."
        />
        <div className="text-center mt-2">
          <Link to="/settings/matching" className="text-sm text-brand-700 hover:underline">
            מעבר להגדרות ← כללי התאמה
          </Link>
        </div>
      </Card>
    );
  }

  const coveragePct = data.coverage.externalsConsidered > 0
    ? Math.round((data.coverage.externalsEmbedded / data.coverage.externalsConsidered) * 100)
    : 0;

  return (
    <div className="space-y-4">
      {/* Coverage + scan-now bar */}
      <Card>
        <CardBody className="flex items-center gap-3 flex-wrap">
          <Sparkles className="h-5 w-5 text-purple-600" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold">דירוג וקטורי לפי דמיון פרופילים</h3>
            <div className="text-xs text-ink-muted num">
              {data.coverage.externalsEmbedded} מתוך {data.coverage.externalsConsidered} מועמדים
              מוטמעים ({coveragePct}%)
              {!data.internalEmbedded && ' · המועמד/ת עדיין לא הוטמע/ה — לחץ "סרוק עכשיו"'}
            </div>
            {(data.coverage.genderSuspectsExcluded ?? 0) > 0 && (
              <div className="text-[11px] text-warning mt-0.5">
                {data.coverage.genderSuspectsExcluded} מועמדים הוסתרו — המגדר הרשום שלהם סותר את
                הטקסט של הפרופיל.{' '}
                <Link to="/insights" className="underline">
                  לתיקון בתובנות ← איכות מגדר
                </Link>
              </div>
            )}
            {running && bf && (
              <div className="mt-1.5 flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-bg-subtle rounded-full overflow-hidden max-w-xs">
                  <div
                    className="bg-purple-500 h-full rounded-full transition-all"
                    style={{
                      width: bf.progressTotal > 0
                        ? `${Math.round((bf.progressCurrent / bf.progressTotal) * 100)}%`
                        : '0%',
                    }}
                  />
                </div>
                <span className="text-[11px] text-ink-muted num">
                  {bf.progressCurrent}/{bf.progressTotal}
                </span>
              </div>
            )}
            {bf?.status === 'error' && bf.lastError && (
              <div className="text-[11px] text-danger mt-1">{bf.lastError}</div>
            )}
          </div>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => matches.refetch()}
            loading={matches.isFetching}
          >
            רענון
          </Button>
          <Button
            size="sm"
            leftIcon={<Sparkles className="h-3.5 w-3.5" />}
            onClick={() => startBackfill.mutate({})}
            loading={startBackfill.isPending || running}
            disabled={running}
          >
            {running ? 'סורק…' : 'סרוק עכשיו'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<ShieldAlert className="h-3.5 w-3.5" />}
            onClick={() => startBackfill.mutate({ force: true })}
            loading={running && bf?.mode === 'force'}
            disabled={running}
            title="עובר על כל המועמדים הפעילים — כולל מי שלא נכנס לוקטורים בסריקה רגילה — ומטמיע כל מקטע חסר"
          >
            סריקה מאולצת
          </Button>
        </CardBody>
      </Card>

      {/* Ranked list, bucketed by similarity score */}
      {data.rows.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            title="אין עדיין תוצאות סמנטיות"
            description={
              data.internalEmbedded
                ? 'המועמדים החיצוניים עדיין לא הוטמעו — לחץ "סרוק עכשיו" כדי להטמיע את כולם.'
                : 'הפרופיל של המועמד/ת עדיין לא הוטמע. לחץ "סרוק עכשיו" ורענן בסיום.'
            }
          />
        </Card>
      ) : (
        <SemanticFilteredBuckets
          rows={data.rows}
          internalCandidateId={internalCandidateId}
          filterSector={filterSector}
          setFilterSector={setFilterSector}
          filterCity={filterCity}
          setFilterCity={setFilterCity}
          ageMin={ageMin}
          setAgeMin={setAgeMin}
          ageMax={ageMax}
          setAgeMax={setAgeMax}
          filtersActive={filtersActive}
        />
      )}
    </div>
  );
}

// ── Filter bar + buckets ────────────────────────────────────
// Sector / city / age narrowing over the ALREADY-ranked rows. These
// dimensions are deliberately not embedded (religious is nuanced,
// background is noise per operator decision) — filtering the ranked
// list gives the same control without polluting the vectors.

function SemanticFilteredBuckets({
  rows,
  internalCandidateId,
  filterSector,
  setFilterSector,
  filterCity,
  setFilterCity,
  ageMin,
  setAgeMin,
  ageMax,
  setAgeMax,
  filtersActive,
}: {
  rows: SemanticMatchRow[];
  internalCandidateId: string;
  filterSector: string;
  setFilterSector: (v: string) => void;
  filterCity: string;
  setFilterCity: (v: string) => void;
  ageMin: string;
  setAgeMin: (v: string) => void;
  ageMax: string;
  setAgeMax: (v: string) => void;
  filtersActive: boolean;
}) {
  const sectors = [...new Set(rows.map((r) => r.sectorGroup).filter(Boolean))] as string[];
  const cities = ([...new Set(rows.map((r) => r.city).filter(Boolean))] as string[])
    .sort((a, b) => a.localeCompare(b, 'he'));

  const min = ageMin ? Number(ageMin) : undefined;
  const max = ageMax ? Number(ageMax) : undefined;
  const filtered = rows.filter((r) => {
    if (filterSector && r.sectorGroup !== filterSector) return false;
    if (filterCity && r.city !== filterCity) return false;
    if (min != null && !Number.isNaN(min) && (r.age == null || r.age < min)) return false;
    if (max != null && !Number.isNaN(max) && (r.age == null || r.age > max)) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex items-center gap-3 flex-wrap">
          <Filter className="h-4 w-4 text-ink-muted" />
          <Select
            value={filterSector}
            onChange={(e) => setFilterSector(e.target.value)}
            className="w-40"
          >
            <option value="">כל המגזרים</option>
            {sectors.map((s) => (
              <option key={s} value={s}>{label('sectorGroup', s)}</option>
            ))}
          </Select>
          <Select
            value={filterCity}
            onChange={(e) => setFilterCity(e.target.value)}
            className="w-40"
          >
            <option value="">כל הערים</option>
            {cities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-ink-muted">גיל</span>
            <Input
              type="number"
              inputMode="numeric"
              placeholder="מ-"
              value={ageMin}
              onChange={(e) => setAgeMin(e.target.value)}
              className="w-16 num"
            />
            <Input
              type="number"
              inputMode="numeric"
              placeholder="עד"
              value={ageMax}
              onChange={(e) => setAgeMax(e.target.value)}
              className="w-16 num"
            />
          </div>
          <span className="text-xs text-ink-muted num">
            {filtered.length} מתוך {rows.length}
          </span>
          {filtersActive && (
            <button
              className="text-xs text-brand-700 hover:underline"
              onClick={() => {
                setFilterSector('');
                setFilterCity('');
                setAgeMin('');
                setAgeMax('');
              }}
            >
              נקה סינון
            </button>
          )}
        </CardBody>
      </Card>

      {filtered.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            title="אין תוצאות בסינון הנוכחי"
            description="שחרר חלק מהפילטרים כדי לראות שוב את הדירוג."
          />
        </Card>
      ) : (
        <SemanticScoreBuckets rows={filtered} internalCandidateId={internalCandidateId} />
      )}
    </div>
  );
}

// ── Similarity score buckets ("קרבות מועמדים") ─────────────
//
// Groups the vector ranking into similarity tiers so the operator can
// scan closeness at a glance instead of scrolling one long list.

const SIMILARITY_BUCKETS: Array<{
  id: string;
  label: string;
  min: number; // inclusive, in percent
  max: number; // inclusive, in percent
  tone: 'success' | 'brand' | 'warning' | 'neutral';
}> = [
  { id: 'high',   label: '80–100', min: 80, max: 100, tone: 'success' },
  { id: 'medium', label: '60–79',  min: 60, max: 79,  tone: 'brand' },
  { id: 'low',    label: '40–59',  min: 40, max: 59,  tone: 'warning' },
  { id: 'far',    label: 'מתחת ל-40', min: 0, max: 39, tone: 'neutral' },
];

function SemanticScoreBuckets({
  rows,
  internalCandidateId,
}: {
  rows: SemanticMatchRow[];
  internalCandidateId: string;
}) {
  // Within a tier every candidate is "vector-close enough", so rank by
  // OUR engine score (matchScore from the PairScore cache) — it folds in
  // the hard rules the vectors ignore. Unscanned rows (no engine score)
  // drop below scored ones and fall back to similarity order.
  const byEngineScore = (a: SemanticMatchRow, b: SemanticMatchRow) =>
    (b.matchScore ?? -1) - (a.matchScore ?? -1) || b.similarity - a.similarity;

  const byBucket = SIMILARITY_BUCKETS.map((b) => ({
    bucket: b,
    items: rows
      .filter((r) => {
        const pct = Math.round(r.similarity * 100);
        return pct >= b.min && pct <= b.max;
      })
      .sort(byEngineScore),
  }));
  // Land the operator on the strongest non-empty tier.
  const initialId = byBucket.find((b) => b.items.length > 0)?.bucket.id;

  return (
    <Tabs
      // Remount when switching candidates so the initial tab recomputes.
      key={internalCandidateId}
      initialId={initialId}
      tabs={byBucket.map(({ bucket, items }) => ({
        id: bucket.id,
        label: `דמיון ${bucket.label}`,
        badge: <Badge tone={items.length ? bucket.tone : 'neutral'}>{items.length}</Badge>,
        content: items.length === 0 ? (
          <Card className="p-6">
            <EmptyState title="אין מועמדים בטווח זה" description="נסה טווח דמיון אחר או הרץ סריקה." />
          </Card>
        ) : (
          <Card>
            <CardBody className="!p-0">
              <ul className="divide-y divide-border">
                {items.map((row) => (
                  <SemanticRowItem
                    key={row.externalCandidateId}
                    row={row}
                    internalCandidateId={internalCandidateId}
                  />
                ))}
              </ul>
            </CardBody>
          </Card>
        ),
      }))}
    />
  );
}

const SemanticRowItem = memo(function SemanticRowItem({
  row,
  internalCandidateId,
}: {
  row: SemanticMatchRow;
  internalCandidateId: string;
}) {
  const qc = useQueryClient();
  const createSuggestion = useMutation({
    mutationFn: () => matchesApi.createManual({
      internalCandidateId,
      externalCandidateId: row.externalCandidateId,
      mode: 'strict',
    }),
    onSuccess: () => {
      toast.success('הצעה נוצרה');
      void qc.invalidateQueries({ queryKey: ['compatibility-board', internalCandidateId] });
      void qc.invalidateQueries({ queryKey: ['internal', internalCandidateId, 'suggestions'] });
    },
    onError: (e) => toast.error('יצירת הצעה נכשלה', (e as Error).message),
  });

  const name = `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() || 'ללא שם';
  const pct = Math.round(row.similarity * 100);

  return (
    <li className="px-5 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <Avatar name={name} size={40} src={row.photoUrl} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              to={`/candidates/external/${row.externalCandidateId}`}
              className="text-sm font-medium hover:underline truncate"
            >
              {name}
            </Link>
            {typeof row.matchScore === 'number' && (
              <Badge tone={row.engineEligible ? 'success' : 'warning'}>
                מנוע: {row.matchScore}
              </Badge>
            )}
          </div>
          <div className="text-xs text-ink-muted flex items-center gap-3 flex-wrap">
            {typeof row.age === 'number' && <span className="num">גיל {row.age}</span>}
            {row.city && <span>{row.city}</span>}
            {row.sectorGroup && <span>{label('sectorGroup', row.sectorGroup)}</span>}
            {row.personalStatus && <span>{label('personalStatus', row.personalStatus)}</span>}
          </div>
          {!!row.highlights?.length && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {row.highlights.map((h) => (
                <Badge key={h} tone="purple">{h}</Badge>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 max-w-sm">
            <div className="flex-1 h-1.5 bg-bg-subtle rounded-full overflow-hidden">
              <div
                className="bg-purple-500 h-full rounded-full"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[11px] text-ink-muted num w-16">דמיון {pct}%</span>
          </div>
        </div>

        <div className="shrink-0 flex flex-col items-end gap-1.5 w-32">
          <div className="text-2xl font-semibold num text-purple-600">{pct}%</div>
          <Button
            size="sm"
            onClick={() => createSuggestion.mutate()}
            loading={createSuggestion.isPending}
          >
            צור הצעה
          </Button>
        </div>
      </div>
    </li>
  );
});

// ── Single row ──────────────────────────────────────────────

const CompatibilityRowItem = memo(function CompatibilityRowItem({
  row,
  onMark,
  onForce,
  onDrilldown,
  internalCandidateId,
}: {
  row: CompatibilityRow;
  onMark: (row: CompatibilityRow) => void;
  onForce: (row: CompatibilityRow) => void;
  onDrilldown: (row: CompatibilityRow) => void;
  internalCandidateId: string;
}) {
  const qc = useQueryClient();
  const aiExplain = useMutation({
    mutationFn: () => pairReviewsApi.aiExplain(internalCandidateId, row.externalCandidateId),
    onSuccess: () => {
      toast.success('סיכום AI נטען');
      qc.invalidateQueries({ queryKey: ['compatibility-board', internalCandidateId] });
    },
    onError: (e) => toast.error('שליפת סיכום AI נכשלה', (e as Error).message),
  });

  const createSuggestion = useMutation({
    mutationFn: () => matchesApi.createManual({
      internalCandidateId,
      externalCandidateId: row.externalCandidateId,
      mode: 'strict',
    }),
    onSuccess: () => {
      toast.success('הצעה נוצרה');
      qc.invalidateQueries({ queryKey: ['compatibility-board', internalCandidateId] });
      qc.invalidateQueries({ queryKey: ['internal', internalCandidateId, 'suggestions'] });
    },
    onError: (e) => toast.error('יצירת הצעה נכשלה', (e as Error).message),
  });

  const name = `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() || 'ללא שם';

  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              to={`/candidates/external/${row.externalCandidateId}`}
              className="text-sm font-medium hover:underline truncate"
            >
              {name}
            </Link>
            <Badge tone={BUCKET_TONE[row.bucket]} icon={BUCKET_ICON[row.bucket]}>
              {BUCKET_LABEL[row.bucket]}
            </Badge>
            {row.matchType && row.bucket !== 'historical' && row.bucket !== 'blocked' && (
              <Badge tone={matchTypeTone(row.matchType)}>
                {label('matchType', row.matchType)}
              </Badge>
            )}
            {row.matchStatus && (row.bucket === 'forced' || row.bucket === 'historical') && (
              <Badge tone="neutral">{label('matchStatus', row.matchStatus)}</Badge>
            )}
            {row.manualStatus && (
              <Badge tone={MANUAL_STATUS_TONE[row.manualStatus]} icon={<History className="h-3 w-3" />}>
                ידני: {MANUAL_STATUS_LABEL[row.manualStatus]}
              </Badge>
            )}
            {row.bucket === 'blocked' && row.forceability === 'with_reason' && (
              <Badge tone="warning"><ShieldAlert className="h-3 w-3" /> ניתן לעקוף</Badge>
            )}
            {row.bucket === 'blocked' && row.forceability === 'none' && (
              <Badge tone="danger"><Lock className="h-3 w-3" /> חסימה קשיחה</Badge>
            )}
          </div>

          <div className="text-xs text-ink-muted flex items-center gap-3 flex-wrap">
            {typeof row.age === 'number' && <span className="num">גיל {row.age}</span>}
            {row.city && <span>{row.city}</span>}
            {row.sectorGroup && <span>{label('sectorGroup', row.sectorGroup)}</span>}
            {row.personalStatus && <span>{label('personalStatus', row.personalStatus)}</span>}
            {row.availabilityStatus && row.availabilityStatus !== 'available' && (
              <Badge tone="warning">{label('availabilityStatus', row.availabilityStatus)}</Badge>
            )}
          </div>

          {/* Deterministic explanation — primary */}
          <ExplanationBlock row={row} />
        </div>

        {/* Right rail: score + actions */}
        <div className="shrink-0 flex flex-col items-end gap-2 w-44">
          {row.bucket !== 'blocked' && row.bucket !== 'historical' && typeof row.matchScore === 'number' && (
            <div className="text-end">
              <div className="text-2xl font-semibold num text-brand-700">{row.matchScore}</div>
              <div className="text-[11px] text-ink-faint num">ביטחון {row.confidenceScore ?? 0}</div>
            </div>
          )}
          <div className="flex flex-col gap-1.5 w-full">
            {row.bucket === 'suitable' && !row.matchSuggestionId && (
              <Button
                size="sm"
                onClick={() => createSuggestion.mutate()}
                loading={createSuggestion.isPending}
              >
                צור הצעה
              </Button>
            )}
            {row.matchSuggestionId && (
              <Link
                to={`/matches/${row.matchSuggestionId}`}
                className="text-xs text-center text-brand-700 hover:underline"
              >
                פתיחת הצעה
              </Link>
            )}
            {row.bucket === 'blocked' && row.forceability === 'with_reason' && (
              <Button size="sm" variant="secondary" onClick={() => onForce(row)}>
                כפה עם נימוק
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => onMark(row)}>
              סמן ידנית
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Sparkles className="h-3.5 w-3.5" />}
              loading={aiExplain.isPending}
              onClick={() => aiExplain.mutate()}
            >
              {row.bucket === 'blocked' || row.bucket === 'weak'
                ? (row.aiExplanation ? 'רענן ניתוח' : 'בדוק למה לא מתאים')
                : (row.aiExplanation ? 'רענן AI' : 'סיכום AI')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDrilldown(row)}>
              פירוט מלא
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
});

function ExplanationBlock({ row }: { row: CompatibilityRow }) {
  return (
    <div className="space-y-1.5 text-sm">
      <div className="font-medium text-ink">{row.explanation.primary}</div>
      {row.explanation.manualOverlay && (
        <div className="rounded-md bg-purple-50 border border-purple-100 px-2.5 py-1.5 text-xs text-purple-900">
          <span className="font-semibold">החלטה ידנית:</span> {row.explanation.manualOverlay}
        </div>
      )}
      {row.explanation.positives.length > 0 && (
        <ul className="list-disc list-inside text-xs text-emerald-700 space-y-0.5">
          {row.explanation.positives.slice(0, 3).map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
      {row.explanation.negatives.length > 0 && (
        <ul className="list-disc list-inside text-xs text-red-700 space-y-0.5">
          {row.explanation.negatives.slice(0, 3).map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
      {row.explanation.warnings.length > 0 && (
        <ul className="list-disc list-inside text-xs text-amber-700 space-y-0.5">
          {row.explanation.warnings.slice(0, 3).map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {(row.aiExplanation?.notMatchReasons?.length ?? 0) > 0 && (
        <div className="mt-2 rounded-md bg-red-50 border border-red-100 px-2.5 py-2 text-xs text-red-900">
          <div className="flex items-center gap-1 font-semibold mb-1">
            <Sparkles className="h-3 w-3" /> סיבות אי-התאמה · נשמרו ותועדו
          </div>
          <ul className="list-disc list-inside space-y-0.5 leading-relaxed">
            {row.aiExplanation!.notMatchReasons!.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {row.aiExplanation?.text && (
        <div className="mt-2 rounded-md bg-sky-50 border border-sky-100 px-2.5 py-2 text-xs text-sky-900">
          <div className="flex items-center gap-1 font-semibold mb-1">
            <Sparkles className="h-3 w-3" /> פרשנות AI · ייעוץ בלבד
          </div>
          <div className="leading-relaxed">{row.aiExplanation.text}</div>
        </div>
      )}
    </div>
  );
}

// ── Manual review dialog ────────────────────────────────────

function ManualReviewDialog({
  internalCandidateId,
  row,
  onClose,
}: {
  internalCandidateId: string;
  row: CompatibilityRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<PairReviewStatus>(row.manualStatus ?? 'review_later');
  const [reason, setReason] = useState(row.operatorReason ?? '');
  const [outcome, setOutcome] = useState(row.outcomeReason ?? '');

  const mutation = useMutation({
    mutationFn: () => pairReviewsApi.upsert(internalCandidateId, row.externalCandidateId, {
      manualStatus: status,
      operatorReason: reason || undefined,
      outcomeReason: outcome || undefined,
      matchSuggestionId: row.matchSuggestionId,
    }),
    onSuccess: () => {
      toast.success('המיפוי הידני נשמר');
      qc.invalidateQueries({ queryKey: ['compatibility-board', internalCandidateId] });
      onClose();
    },
    onError: (e) => toast.error('שמירת המיפוי נכשלה', (e as Error).message),
  });

  const clearMutation = useMutation({
    mutationFn: () => pairReviewsApi.clear(internalCandidateId, row.externalCandidateId),
    onSuccess: () => {
      toast.success('המיפוי הידני נמחק');
      qc.invalidateQueries({ queryKey: ['compatibility-board', internalCandidateId] });
      onClose();
    },
    onError: (e) => toast.error('מחיקת המיפוי נכשלה', (e as Error).message),
  });

  const reasonRequired = status === 'not_suitable';
  const outcomeRequired = status === 'rejected_after_contact';
  const canSave = (!reasonRequired || reason.trim().length > 0)
    && (!outcomeRequired || outcome.trim().length > 0);

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title={`סימון ידני · ${row.firstName ?? ''} ${row.lastName ?? ''}`.trim()}
      description="ההחלטה תישמר בזיכרון הזוג ותוצג בכל פעם שתעריך אותו מחדש. אינה משפיעה על תוצאת המנוע."
      primaryAction={{
        label: 'שמור',
        onClick: () => mutation.mutate(),
        loading: mutation.isPending,
        disabled: !canSave,
      }}
      secondaryAction={{ label: 'ביטול', onClick: onClose }}
    >
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-ink-muted block mb-1">סטטוס ידני</label>
          <Select value={status} onChange={(e) => setStatus(e.target.value as PairReviewStatus)}>
            {(Object.keys(MANUAL_STATUS_LABEL) as PairReviewStatus[]).map((s) => (
              <option key={s} value={s}>{MANUAL_STATUS_LABEL[s]}</option>
            ))}
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-ink-muted block mb-1">
            סיבה / הערה {reasonRequired && <span className="text-red-600">*</span>}
          </label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="לדוגמה: מגזר חזק מדי לפי שיחה עם הצד; הופנה ע״י המשפחה ללא היכרות; וכו'."
          />
        </div>
        {(status === 'rejected_after_contact') && (
          <div>
            <label className="text-xs font-medium text-ink-muted block mb-1">
              סיבת הכישלון לאחר קשר <span className="text-red-600">*</span>
            </label>
            <Textarea
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="לדוגמה: צד א׳ סירב; חוסר התאמה משפחתית; הופסק ע״י השדכנית."
            />
          </div>
        )}
        {row.manualStatus && (
          <div className="flex items-center justify-between text-xs text-ink-muted">
            <span>החלטה אחרונה: {MANUAL_STATUS_LABEL[row.manualStatus]} ({row.reviewedAt ? new Date(row.reviewedAt).toLocaleString('he-IL') : '—'})</span>
            <Button variant="ghost" size="sm" onClick={() => clearMutation.mutate()} loading={clearMutation.isPending}>
              נקה החלטה
            </Button>
          </div>
        )}
        {(row.reviewHistoryCount ?? 0) > 0 && (
          <div className="text-[11px] text-ink-faint">
            {row.reviewHistoryCount} החלטות קודמות נשמרות בהיסטוריית הזוג.
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── Force match dialog ──────────────────────────────────────

function ForceMatchDialog({
  internalCandidateId,
  row,
  onClose,
}: {
  internalCandidateId: string;
  row: CompatibilityRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [justification, setJustification] = useState('');
  const mutation = useMutation({
    mutationFn: () => matchesApi.force({
      internalCandidateId,
      externalCandidateId: row.externalCandidateId,
      mode: 'strict',
      justification,
    }),
    onSuccess: async () => {
      toast.success('הצעה כפויה נוצרה');
      // Mirror as manual "forced" review so the operator's own decision
      // is preserved on the board overlay alongside the suggestion.
      try {
        await pairReviewsApi.upsert(internalCandidateId, row.externalCandidateId, {
          manualStatus: 'forced',
          operatorReason: justification,
        });
      } catch { /* non-blocking */ }
      qc.invalidateQueries({ queryKey: ['compatibility-board', internalCandidateId] });
      qc.invalidateQueries({ queryKey: ['internal', internalCandidateId, 'suggestions'] });
      onClose();
    },
    onError: (e) => toast.error('הכפייה נכשלה', (e as Error).message),
  });

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title={`כפיית הצעה — ${row.firstName ?? ''} ${row.lastName ?? ''}`.trim()}
      description="כל החסימות הניתנות לעקיפה יישמרו בהצעה לתיעוד. שדה הנימוק חובה (10 תווים לפחות)."
      primaryAction={{
        label: 'אשר וכפה',
        onClick: () => mutation.mutate(),
        loading: mutation.isPending,
        disabled: justification.trim().length < 10,
        variant: 'danger',
      }}
      secondaryAction={{ label: 'ביטול', onClick: onClose }}
    >
      <div className="space-y-3">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 space-y-1">
          {row.blockers.map((b) => (
            <div key={b.code}>· {b.message}</div>
          ))}
        </div>
        <Textarea
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          placeholder="נימוק תפעולי: למה לעקוף את החסימות (חובה — לפחות 10 תווים)."
          rows={4}
        />
      </div>
    </Dialog>
  );
}

// ── Drilldown dialog ────────────────────────────────────────

function PairDrilldownDialog({
  internalCandidateId,
  row,
  onClose,
  onMark,
  onForce,
}: {
  internalCandidateId: string;
  row: CompatibilityRow;
  onClose: () => void;
  onMark: () => void;
  onForce: () => void;
}) {
  const q = useQuery({
    queryKey: ['compatibility-pair', internalCandidateId, row.externalCandidateId],
    queryFn: () => compatibilityApi.pairCheck(internalCandidateId, {
      externalCandidateId: row.externalCandidateId,
      mode: 'strict',
    }),
  });

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title={`פירוט זוג · ${row.firstName ?? ''} ${row.lastName ?? ''}`.trim()}
      secondaryAction={{ label: 'סגור', onClick: onClose }}
    >
      <div className="max-h-[70vh] overflow-y-auto -mx-1 px-1">
        {q.isLoading && <LoadingSkeleton rows={4} />}
        {q.isError && <ErrorState description={(q.error as Error).message} onRetry={() => q.refetch()} />}
        {q.data && (
          <PairDrilldownContent
            data={q.data.data}
            onMark={onMark}
            onForce={onForce}
          />
        )}
      </div>
    </Dialog>
  );
}

function PairDrilldownContent({
  data, onMark, onForce,
}: {
  data: PairCheckResult;
  onMark: () => void;
  onForce: () => void;
}) {
  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-md bg-zinc-50 border border-zinc-200 p-3">
        <div className="text-xs font-semibold mb-1 inline-flex items-center gap-1">
          <Filter className="h-3 w-3" /> תוצאת מנוע (דטרמיניסטית)
        </div>
        <div className="font-medium">{data.explanation.primary}</div>
      </div>

      {data.engine && (
        <div>
          <div className="text-xs font-semibold text-ink-muted mb-1">פירוט ציון לפי מימדים</div>
          <ul className="space-y-1">
            {data.engine.scoreBreakdown.map((d) => (
              <li key={d.dimension} className="flex items-center justify-between text-xs">
                <span>{label('scoringDimension', d.dimension)}</span>
                <span className="num text-ink-muted">{d.score} × {(d.weight * 100).toFixed(0)}% = {d.weightedScore.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.engine && data.engine.blockers.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-red-700 mb-1">חסימות מנוע</div>
          <ul className="text-xs space-y-1">
            {data.engine.blockers.map((b) => (
              <li key={b.code}>
                <Badge tone={severityTone(b.severity)}>{b.severity}</Badge>
                <span className="ms-2">{b.message}</span>
                <span className="ms-1 text-ink-faint">[{b.overridable}]</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.pairReview && (
        <div className="rounded-md bg-purple-50 border border-purple-100 p-3">
          <div className="text-xs font-semibold mb-1 inline-flex items-center gap-1">
            <History className="h-3 w-3" /> זיכרון תפעולי לזוג
          </div>
          <div>סטטוס ידני: {MANUAL_STATUS_LABEL[data.pairReview.manualStatus]}</div>
          {data.pairReview.operatorReason && (
            <div className="text-xs mt-1">סיבה: {data.pairReview.operatorReason}</div>
          )}
          {data.pairReview.outcomeReason && (
            <div className="text-xs mt-1">תוצאה: {data.pairReview.outcomeReason}</div>
          )}
          <div className="text-[11px] text-ink-faint mt-1">
            עודכן {new Date(data.pairReview.reviewedAt).toLocaleString('he-IL')} · {data.pairReview.historyCount} החלטות קודמות
          </div>
        </div>
      )}

      {data.pairReview?.aiExplanation?.text && (
        <div className="rounded-md bg-sky-50 border border-sky-100 p-3 text-xs">
          <div className="font-semibold inline-flex items-center gap-1 mb-1">
            <Sparkles className="h-3 w-3" /> פרשנות AI · ייעוץ בלבד
          </div>
          <div className="whitespace-pre-wrap leading-relaxed">{data.pairReview.aiExplanation.text}</div>
          {(data.pairReview.aiExplanation.strengths?.length ?? 0) > 0 && (
            <ul className="list-disc list-inside text-emerald-800 mt-1">
              {data.pairReview.aiExplanation.strengths!.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          )}
          {(data.pairReview.aiExplanation.concerns?.length ?? 0) > 0 && (
            <ul className="list-disc list-inside text-red-800 mt-1">
              {data.pairReview.aiExplanation.concerns!.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          )}
          {(data.pairReview.aiExplanation.notMatchReasons?.length ?? 0) > 0 && (
            <div className="mt-1.5">
              <div className="font-semibold text-red-800">סיבות אי-התאמה (מתועד):</div>
              <ul className="list-disc list-inside text-red-800">
                {data.pairReview.aiExplanation.notMatchReasons!.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          <div className="text-[11px] text-ink-faint mt-1">
            {data.pairReview.aiExplanation.provider} · {data.pairReview.aiExplanation.generatedAt ? new Date(data.pairReview.aiExplanation.generatedAt).toLocaleString('he-IL') : ''}
          </div>
        </div>
      )}

      {data.existingSuggestion && (
        <div className="rounded-md bg-zinc-50 border border-zinc-200 p-3 text-xs">
          <div className="font-semibold mb-1">הצעה קיימת</div>
          <div>סטטוס: {label('matchStatus', data.existingSuggestion.status)}</div>
          {data.existingSuggestion.forcedOverride && <div>מסומנת כהצעה כפויה</div>}
          {data.existingSuggestion.closeReason && <div>סיבת סגירה: {data.existingSuggestion.closeReason}</div>}
          <Link
            to={`/matches/${data.existingSuggestion.matchSuggestionId}`}
            className="text-brand-700 hover:underline"
          >
            פתח את ההצעה
          </Link>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" variant="secondary" onClick={onMark}>סמן ידנית</Button>
        {data.forceability === 'with_reason' && (
          <Button size="sm" variant="secondary" onClick={onForce}>כפה עם נימוק</Button>
        )}
      </div>
    </div>
  );
}

// ── Manual pair-check dialog ────────────────────────────────

function PairCheckDialog({
  internalCandidateId,
  onClose,
}: {
  internalCandidateId: string;
  onClose: () => void;
}) {
  // The picker debounces typing itself and reports the settled query.
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ExternalCandidate | null>(null);

  const externals = useQuery({
    queryKey: ['external-search', search],
    queryFn: () => externalCandidatesApi.list({
      search: search.length >= 2 ? search : undefined,
      limit: 50,
      sort: 'firstName',
      order: 'asc',
    }),
  });
  const items = externals.data?.data ?? [];

  const result = useQuery({
    queryKey: ['pair-check', internalCandidateId, selected?._id],
    queryFn: () => compatibilityApi.pairCheck(internalCandidateId, {
      externalCandidateId: selected!._id,
      mode: 'strict',
    }),
    enabled: !!selected,
  });

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title="בדיקה ידנית של זוג מועמדים"
      description="בחר מועמד חיצוני מסוים כדי לבדוק תאימות. אם החסימה ניתנת לעקיפה, ניתן לכפות הצעה. אחרת תוצג הסיבה המדויקת."
      secondaryAction={{ label: 'סגור', onClick: onClose }}
    >
      <div className="space-y-3 max-h-[70vh] overflow-y-auto -mx-1 px-1">
        <CandidatePicker
          options={items.map(externalToOption)}
          value={selected?._id ?? ''}
          selectedOption={selected ? externalToOption(selected) : undefined}
          onChange={(id) => setSelected(items.find((c) => c._id === id) ?? null)}
          onQueryChange={setSearch}
          loading={externals.isFetching}
          placeholder="בחר מועמד חיצוני לבדיקה"
          searchPlaceholder="חיפוש לפי שם, טלפון או מקור…"
        />
        {selected && (
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold">
                בדיקה: {selected.firstName ?? ''} {selected.lastName ?? ''}
              </h3>
            </CardHeader>
            <CardBody>
              {result.isLoading && <LoadingSkeleton rows={4} />}
              {result.isError && <ErrorState description={(result.error as Error).message} onRetry={() => result.refetch()} />}
              {result.data && <PairCheckResultPanel data={result.data.data} internalCandidateId={internalCandidateId} onClose={onClose} />}
            </CardBody>
          </Card>
        )}
      </div>
    </Dialog>
  );
}

function PairCheckResultPanel({
  data, internalCandidateId, onClose,
}: {
  data: PairCheckResult;
  internalCandidateId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => matchesApi.createManual({
      internalCandidateId,
      externalCandidateId: data.externalCandidateId,
      mode: 'strict',
    }),
    onSuccess: () => {
      toast.success('הצעה נוצרה');
      qc.invalidateQueries({ queryKey: ['compatibility-board', internalCandidateId] });
      qc.invalidateQueries({ queryKey: ['internal', internalCandidateId, 'suggestions'] });
      onClose();
    },
    onError: (e) => toast.error('יצירת הצעה נכשלה', (e as Error).message),
  });

  return (
    <div className="space-y-3 text-sm">
      <div className="font-medium">{data.explanation.primary}</div>
      {data.engine && (
        <div className="text-xs text-ink-muted">
          ציון {data.engine.matchScore} · ביטחון {data.engine.confidenceScore} · סוג: {label('matchType', data.engine.matchType)}
        </div>
      )}
      {data.engine && data.engine.blockers.length > 0 && (
        <ul className="text-xs space-y-1">
          {data.engine.blockers.map((b) => (
            <li key={b.code} className="flex items-start gap-2">
              {b.severity === 'hard_non_overridable' ? <Lock className="h-3 w-3 mt-0.5 text-red-700" /> : b.severity === 'hard_overridable' ? <ShieldAlert className="h-3 w-3 mt-0.5 text-amber-700" /> : <AlertTriangle className="h-3 w-3 mt-0.5 text-amber-600" />}
              <span>{b.message}</span>
            </li>
          ))}
        </ul>
      )}
      {data.existingSuggestion && (
        <div className="rounded-md bg-zinc-50 border border-zinc-200 px-2.5 py-2 text-xs">
          קיימת הצעה ({label('matchStatus', data.existingSuggestion.status)}) · <Link className="text-brand-700 hover:underline" to={`/matches/${data.existingSuggestion.matchSuggestionId}`}>פתח</Link>
        </div>
      )}
      {data.pairReview && (
        <div className="rounded-md bg-purple-50 border border-purple-100 px-2.5 py-2 text-xs">
          זיכרון תפעולי: {MANUAL_STATUS_LABEL[data.pairReview.manualStatus]}
          {data.pairReview.operatorReason && ` — ${data.pairReview.operatorReason}`}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        {data.engine?.eligible && !data.existingSuggestion && (
          <Button size="sm" onClick={() => create.mutate()} loading={create.isPending}>צור הצעה</Button>
        )}
        <Link
          to={`/candidates/external/${data.externalCandidateId}`}
          className="text-xs text-brand-700 hover:underline self-center"
        >
          פרופיל
        </Link>
      </div>
      {!data.engine?.eligible && (
        <div className="text-xs text-ink-muted flex items-center gap-1">
          <Clock className="h-3 w-3" /> לא ניתן ליצור הצעה ישירות. ראה פירוט החסימות לעיל.
        </div>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────

function matchTypeTone(t: string): 'success' | 'brand' | 'warning' | 'danger' {
  switch (t) {
    case 'safe':     return 'success';
    case 'balanced': return 'brand';
    case 'creative': return 'warning';
    default:         return 'danger';
  }
}

function severityTone(s: string): 'danger' | 'warning' | 'neutral' {
  switch (s) {
    case 'hard_non_overridable': return 'danger';
    case 'hard_overridable':     return 'warning';
    default:                      return 'neutral';
  }
}
