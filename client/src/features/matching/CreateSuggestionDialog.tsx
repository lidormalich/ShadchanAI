// ═══════════════════════════════════════════════════════════
// CreateSuggestionDialog — manual match-suggestion creation from
// the matches pipeline (and the topbar "new action" menu).
//
// The operator searches and picks an internal + external candidate.
// Once both are chosen the engine evaluates the pair (live preview),
// and "create" persists a draft MatchSuggestion via POST /matches.
//
// This is the global counterpart to the per-candidate flows in
// CompatibilityWorkspace / FindMatchesDialog, reachable without
// first drilling into a specific internal candidate.
// ═══════════════════════════════════════════════════════════

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Input, Select, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState, LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { label } from '@/utils/labels';
import { internalCandidatesApi, externalCandidatesApi } from '@/services/api/candidates';
import { matchesApi } from '@/services/api/matches';
import { pairReviewsApi } from '@/services/api/pair-reviews';
import type { InternalCandidate, ExternalCandidate } from '@/types/domain';

interface EvalResult {
  eligible: boolean;
  matchScore: number;
  confidenceScore: number;
  matchType: 'safe' | 'balanced' | 'creative' | 'risky';
  hardBlockers: string[];
  blockers?: Array<{ code: string; message: string; overridable: string }>;
}

const MIN_JUSTIFICATION = 10;
// Below this engine score a pair is "weak" enough to warrant a
// documented "why not a match" check even if it's technically eligible.
const WEAK_SCORE = 55;

export function CreateSuggestionDialog({
  open, onClose, initialExternal,
}: {
  open: boolean;
  onClose: () => void;
  // When opened from an external candidate's drawer the external side is
  // already known, so we pre-seed it and the operator only picks the internal.
  initialExternal?: ExternalCandidate | null;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'strict' | 'discovery'>('discovery');
  const [internal, setInternal] = useState<InternalCandidate | null>(null);
  const [external, setExternal] = useState<ExternalCandidate | null>(initialExternal ?? null);
  const [justification, setJustification] = useState('');

  // Re-seed the external side whenever the dialog opens with a provided candidate.
  useEffect(() => {
    if (open && initialExternal) setExternal(initialExternal);
  }, [open, initialExternal]);

  // Whenever the selected pair changes, drop any why-not reasons /
  // justification carried over from the previous pair.
  useEffect(() => {
    setJustification('');
    whyNot.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internal?._id, external?._id]);

  // Live engine preview once both sides are chosen.
  const evalQuery = useQuery({
    queryKey: ['evaluate-pair', internal?._id, external?._id, mode],
    queryFn: () => matchesApi.evaluate({
      internalCandidateId: internal!._id,
      externalCandidateId: external!._id,
      mode,
    }) as unknown as Promise<{ data: EvalResult }>,
    enabled: !!internal && !!external,
  });

  const create = useMutation({
    mutationFn: () => matchesApi.createManual({
      internalCandidateId: internal!._id,
      externalCandidateId: external!._id,
      mode,
    }),
    onSuccess: () => {
      toast.success('הצעת שידוך נוצרה');
      qc.invalidateQueries({ queryKey: ['matches'] });
      reset();
      onClose();
    },
    onError: (e) => toast.error('יצירת הצעה נכשלה', (e as Error).message),
  });

  // Force a suggestion past overridable blockers (with a recorded
  // justification). When an active suggestion already exists for the
  // pair the server refreshes + forces it in place rather than creating
  // a duplicate — so "force" always yields an active, documented row.
  const force = useMutation({
    mutationFn: () => matchesApi.force({
      internalCandidateId: internal!._id,
      externalCandidateId: external!._id,
      mode,
      justification,
    }),
    onSuccess: () => {
      toast.success('הצעה כפויה נוצרה / רועננה');
      qc.invalidateQueries({ queryKey: ['matches'] });
      reset();
      onClose();
    },
    onError: (e) => toast.error('הכפייה נכשלה', (e as Error).message),
  });

  // "בדוק למה לא מתאים" — runs the single AI explain pass; its
  // notMatchReasons array is the documented "why not" list (also saved
  // on the pair + fed into the reasons bank server-side).
  const whyNot = useMutation({
    mutationFn: () => pairReviewsApi.aiExplain(internal!._id, external!._id),
    onError: (e) => toast.error('שליפת הסיבות נכשלה', (e as Error).message),
  });

  function reset() {
    setInternal(null);
    setExternal(initialExternal ?? null);
    setJustification('');
    whyNot.reset();
  }

  const result = evalQuery.data?.data;
  const canCreate = !!internal && !!external && result?.eligible === true;
  // Forceable only when every blocker is overridable-with-reason (no
  // hard, non-overridable blocker like same-gender / not-active).
  const blockers = result?.blockers ?? [];
  const hasNonOverridable = blockers.some((b) => b.overridable === 'none');
  const canForce = !!internal && !!external && result?.eligible === false && !hasNonOverridable;
  const whyNotReasons = whyNot.data?.data.ai.notMatchReasons ?? [];

  return (
    <Dialog
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="צור הצעת שידוך ידנית"
      description="בחר מועמד פנימי ומועמד חיצוני. המנוע ינתח את הזוג, ואם הוא כשיר ניתן ליצור הצעה."
      primaryAction={
        canForce
          ? {
              label: 'כפה עם נימוק',
              onClick: () => force.mutate(),
              loading: force.isPending,
              disabled: justification.trim().length < MIN_JUSTIFICATION,
              variant: 'danger',
            }
          : {
              label: 'צור הצעה',
              onClick: () => create.mutate(),
              loading: create.isPending,
              disabled: !canCreate,
            }
      }
      secondaryAction={{ label: 'ביטול', onClick: () => { reset(); onClose(); } }}
    >
      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-ink-muted block mb-1">מצב ניתוח</label>
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'strict' | 'discovery')}>
            <option value="discovery">גילוי (רחב — ציון ≥ 30)</option>
            <option value="strict">הדוק (ציון ≥ 55)</option>
          </Select>
        </div>

        <CandidatePicker
          title="מועמד פנימי"
          selected={internal ? `${internal.firstName ?? ''} ${internal.lastName ?? ''}`.trim() || 'ללא שם' : null}
          onClear={() => setInternal(null)}
          renderResults={(search) => (
            <InternalResults search={search} onPick={setInternal} />
          )}
        />

        <CandidatePicker
          title="מועמד חיצוני"
          selected={external ? `${external.firstName ?? ''} ${external.lastName ?? ''}`.trim() || 'ללא שם' : null}
          onClear={() => setExternal(null)}
          renderResults={(search) => (
            <ExternalResults search={search} onPick={setExternal} />
          )}
        />

        {internal && external && (
          <div className="rounded-md border border-border bg-bg-subtle p-3 text-sm">
            {evalQuery.isLoading ? (
              <LoadingSkeleton rows={2} />
            ) : evalQuery.isError ? (
              <div className="text-xs text-danger">ניתוח הזוג נכשל: {(evalQuery.error as Error).message}</div>
            ) : result ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="text-end">
                    <span className="text-2xl font-semibold num text-brand-700">{result.matchScore}</span>
                    <span className="text-[11px] text-ink-faint num ms-1">ביטחון {result.confidenceScore}</span>
                  </div>
                  <Badge tone={result.matchType === 'safe' ? 'success' : result.matchType === 'balanced' ? 'brand' : 'warning'}>
                    {label('matchType', result.matchType)}
                  </Badge>
                  {result.eligible
                    ? <Badge tone="success">כשיר ליצירה</Badge>
                    : <Badge tone="danger">לא כשיר</Badge>}
                </div>
                {!result.eligible && (result.blockers?.length || result.hardBlockers?.length) ? (
                  <div>
                    <div className="text-[11px] font-semibold text-ink-muted mb-0.5">חסימות מנוע</div>
                    <ul className="text-xs text-red-700 list-disc list-inside space-y-0.5">
                      {(result.blockers?.map((b) => b.message) ?? result.hardBlockers).slice(0, 4).map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {/* "בדוק למה לא מתאים" — AI reasons, saved + documented.
                    Shown for blocked pairs AND weak-but-eligible ones
                    (e.g. a low score with no hard blocker). */}
                {(!result.eligible || result.matchScore < WEAK_SCORE) && (
                  <div className="space-y-2 pt-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      leftIcon={<Sparkles className="h-3.5 w-3.5" />}
                      loading={whyNot.isPending}
                      onClick={() => whyNot.mutate()}
                    >
                      בדוק למה לא מתאים
                    </Button>

                    {whyNotReasons.length > 0 && (
                      <div className="rounded-md bg-sky-50 border border-sky-100 px-2.5 py-2 text-xs text-sky-900">
                        <div className="flex items-center gap-1 font-semibold mb-1">
                          <Sparkles className="h-3 w-3" /> סיבות אי-התאמה · נשמרו ותועדו
                        </div>
                        <ul className="list-disc list-inside space-y-0.5 leading-relaxed">
                          {whyNotReasons.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      </div>
                    )}

                    {/* Force is only relevant when the pair is actually blocked. */}
                    {!result.eligible && (canForce ? (
                      <div>
                        <label className="text-[11px] font-medium text-ink-muted block mb-1">
                          נימוק לכפייה (חובה — לפחות {MIN_JUSTIFICATION} תווים)
                        </label>
                        <Textarea
                          value={justification}
                          onChange={(e) => setJustification(e.target.value)}
                          placeholder="למה לעקוף את החסימות? הנימוק יישמר בהצעה לתיעוד."
                          rows={3}
                        />
                        <div className="text-[11px] text-ink-faint mt-1">
                          אם כבר קיימת הצעה פעילה לזוג — הכפייה תרענן ותסמן את הקיימת (לא נוצרת כפילות).
                        </div>
                      </div>
                    ) : (
                      <div className="text-[11px] text-ink-muted">
                        קיימת חסימה קשיחה שאינה ניתנת לעקיפה — לא ניתן לכפות הצעה לזוג זה.
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── Generic picker shell: shows selected chip or a search box ──

function CandidatePicker({
  title, selected, onClear, renderResults,
}: {
  title: string;
  selected: string | null;
  onClear: () => void;
  renderResults: (search: string) => React.ReactNode;
}) {
  const [search, setSearch] = useState('');

  return (
    <div>
      <label className="text-xs font-medium text-ink-muted block mb-1">{title}</label>
      {selected ? (
        <div className="flex items-center justify-between rounded-md border border-border bg-white px-3 py-2">
          <span className="text-sm font-medium truncate">{selected}</span>
          <button type="button" onClick={onClear} className="text-ink-faint hover:text-ink shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute top-1/2 -translate-y-1/2 start-2.5 text-ink-faint" />
            <Input
              className="ps-8"
              placeholder="חיפוש לפי שם (לפחות 2 תווים)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {search.trim().length >= 2 && renderResults(search)}
        </div>
      )}
    </div>
  );
}

function InternalResults({ search, onPick }: { search: string; onPick: (c: InternalCandidate) => void }) {
  const q = useQuery({
    queryKey: ['internal-search', search],
    queryFn: () => internalCandidatesApi.list({ search, limit: 15, status: 'active' }),
    enabled: search.trim().length >= 2,
  });
  return <ResultsList loading={q.isLoading} items={q.data?.data ?? []} onPick={onPick} />;
}

function ExternalResults({ search, onPick }: { search: string; onPick: (c: ExternalCandidate) => void }) {
  const q = useQuery({
    queryKey: ['external-search', search],
    queryFn: () => externalCandidatesApi.list({ search, limit: 15, status: 'active' }),
    enabled: search.trim().length >= 2,
  });
  return <ResultsList loading={q.isLoading} items={q.data?.data ?? []} onPick={onPick} />;
}

function ResultsList<T extends { _id: string; firstName?: string; lastName?: string; city?: string; age?: number; sectorGroup?: string }>({
  loading, items, onPick,
}: {
  loading: boolean;
  items: T[];
  onPick: (c: T) => void;
}) {
  if (loading) return <LoadingSkeleton rows={2} />;
  if (items.length === 0) return <EmptyState title="לא נמצאו מועמדים" />;
  return (
    <ul className="border border-border rounded-md max-h-44 overflow-y-auto divide-y divide-border bg-white">
      {items.map((c) => (
        <li key={c._id}>
          <button
            type="button"
            className="w-full text-start px-3 py-2 hover:bg-bg-hover text-sm"
            onClick={() => onPick(c)}
          >
            <div className="font-medium">{`${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'ללא שם'}</div>
            <div className="text-xs text-ink-muted flex items-center gap-2 flex-wrap">
              {typeof c.age === 'number' && <span className="num">גיל {c.age}</span>}
              {c.city && <span>{c.city}</span>}
              {c.sectorGroup && <span>{label('sectorGroup', c.sectorGroup)}</span>}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
