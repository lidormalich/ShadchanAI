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
import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Select, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { CandidatePicker } from '@/components/ui/CandidatePicker';
import { LoadingSkeleton } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { label } from '@/utils/labels';
import { internalToOption, externalToOption } from '@/features/candidates/candidateOptions';
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

        <InternalPickerField value={internal} onPick={setInternal} />
        <ExternalPickerField value={external} onPick={setExternal} />

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

// ── Picker fields: server-searched CandidatePicker per side ──
// Empty query → a browsable first page; typing (2+ chars) → server
// search by name/phone/source. The picked FULL candidate object is
// what the dialog needs (the engine preview reads both ids), so we
// resolve the chosen id back to the fetched item.

function InternalPickerField({
  value, onPick,
}: {
  value: InternalCandidate | null;
  onPick: (c: InternalCandidate | null) => void;
}) {
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['internal-picker', q],
    queryFn: () => internalCandidatesApi.list({
      search: q.length >= 2 ? q : undefined,
      limit: 50,
      status: 'active',
      sort: 'firstName',
      order: 'asc',
    }),
  });
  const items = list.data?.data ?? [];
  return (
    <div>
      <label className="text-xs font-medium text-ink-muted block mb-1">מועמד פנימי</label>
      <CandidatePicker
        options={items.map(internalToOption)}
        value={value?._id ?? ''}
        selectedOption={value ? internalToOption(value) : undefined}
        onChange={(id) => onPick(items.find((c) => c._id === id) ?? null)}
        onQueryChange={setQ}
        loading={list.isFetching}
        placeholder="בחר מועמד פנימי"
      />
    </div>
  );
}

function ExternalPickerField({
  value, onPick,
}: {
  value: ExternalCandidate | null;
  onPick: (c: ExternalCandidate | null) => void;
}) {
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['external-picker', q],
    queryFn: () => externalCandidatesApi.list({
      search: q.length >= 2 ? q : undefined,
      limit: 50,
      status: 'active',
      sort: 'firstName',
      order: 'asc',
    }),
  });
  const items = list.data?.data ?? [];
  return (
    <div>
      <label className="text-xs font-medium text-ink-muted block mb-1">מועמד חיצוני</label>
      <CandidatePicker
        options={items.map(externalToOption)}
        value={value?._id ?? ''}
        selectedOption={value ? externalToOption(value) : undefined}
        onChange={(id) => onPick(items.find((c) => c._id === id) ?? null)}
        onQueryChange={setQ}
        loading={list.isFetching}
        placeholder="בחר מועמד חיצוני"
        searchPlaceholder="חיפוש לפי שם, טלפון או מקור…"
      />
    </div>
  );
}
