// ═══════════════════════════════════════════════════════════
// DiscoveryRankingSection — the "לפי ההיכרות" tab on the
// compatibility board: the external pool ranked by the candidate's
// REVEALED preferences (swipe verdicts + AI summary), blended with
// the deterministic engine score (75/25, same formula the public
// swipe feed uses). Real identities — auth-gated surface.
// ═══════════════════════════════════════════════════════════

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, Heart, Sparkles, UserCog } from 'lucide-react';
import { Badge, Button, Card, CardBody, Spinner } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState, ErrorState } from '@/components/states/states';
import { toast } from '@/components/ui/Toast';
import { label } from '@/utils/labels';
import { matchesApi } from '@/services/api/matches';
import { CandidateVerdictBadge } from '@/features/discovery/CandidateVerdictBadge';
import {
  getPreferenceRanking,
  getProfileProposal,
  applyProfileProposal,
  type RevealedPreferenceRow,
} from '@/services/api/discovery';

function RankingRow({
  row,
  internalCandidateId,
}: {
  row: RevealedPreferenceRow;
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
  const prefPct = row.prefSim !== undefined ? Math.round(row.prefSim * 100) : undefined;

  return (
    <li className="px-5 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              to={`/candidates/external/${row.externalCandidateId}`}
              className="text-sm font-medium hover:underline truncate"
            >
              {name}
            </Link>
            <Badge tone="neutral">מנוע: {row.engineScore}</Badge>
            {prefPct !== undefined && (
              <Badge tone="brand" icon={<Heart className="h-3 w-3" />}>
                התאמה להעדפות {prefPct}%
              </Badge>
            )}
            <CandidateVerdictBadge verdict={row.candidateVerdict} />
          </div>
          <div className="text-xs text-ink-muted flex items-center gap-3 flex-wrap">
            {typeof row.age === 'number' && <span className="num">גיל {row.age}</span>}
            {row.city && <span>{row.city}</span>}
            {row.sectorGroup && <span>{label('sectorGroup', row.sectorGroup)}</span>}
            {row.personalStatus && <span>{label('personalStatus', row.personalStatus)}</span>}
          </div>
          {row.strengths.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {row.strengths.map((s) => <Badge key={s} tone="success">{s}</Badge>)}
            </div>
          )}
        </div>

        <div className="shrink-0 flex flex-col items-end gap-1.5 w-36 text-end">
          <div className="text-2xl font-semibold num text-brand-700">{row.finalRank}</div>
          <div className="text-[11px] text-ink-faint">ציון משוקלל</div>
          {row.candidateVerdict?.verdict !== 'reject' && (
            <Button
              size="sm"
              onClick={() => createSuggestion.mutate()}
              loading={createSuggestion.isPending}
            >
              צור הצעה
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

// ── "החל על הפרופיל" — operator-approved profile update ──

function ApplyToProfileDialog({
  internalCandidateId,
  onClose,
}: {
  internalCandidateId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [accepted, setAccepted] = useState<Set<string> | null>(null);

  const proposal = useQuery({
    queryKey: ['discovery-profile-proposal', internalCandidateId],
    queryFn: () => getProfileProposal(internalCandidateId),
  });

  // Default: everything checked once the proposal arrives.
  const changes = proposal.data?.changes ?? [];
  const checked = accepted ?? new Set(changes.map((c) => c.key));

  const apply = useMutation({
    mutationFn: () => applyProfileProposal(internalCandidateId, [...checked]),
    onSuccess: (res) => {
      toast.success('הפרופיל עודכן', `${res.applied.length} שינויים הוחלו מההיכרות החכמה`);
      void qc.invalidateQueries({ queryKey: ['internal', internalCandidateId] });
      void qc.invalidateQueries({ queryKey: ['compatibility-board', internalCandidateId] });
      void qc.invalidateQueries({ queryKey: ['discovery-ranking', internalCandidateId] });
      void qc.invalidateQueries({ queryKey: ['discovery-profile-proposal', internalCandidateId] });
      onClose();
    },
    onError: (e) => toast.error('החלת השינויים נכשלה', (e as Error).message),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="החלת ההעדפות שנחשפו על הפרופיל"
      description="סמנו אילו שינויים להחיל. העדכון נרשם ביומן הפעילות כמו עריכה ידנית."
      primaryAction={{
        label: `החל ${checked.size} שינויים`,
        onClick: () => apply.mutate(),
        loading: apply.isPending,
        disabled: checked.size === 0 || !proposal.data?.available,
      }}
      secondaryAction={{ label: 'ביטול', onClick: onClose }}
    >
      {proposal.isLoading ? (
        <div className="flex justify-center py-6"><Spinner className="h-5 w-5 text-brand" /></div>
      ) : !proposal.data?.available ? (
        <p className="text-sm text-ink-muted">
          {proposal.data?.reason === 'no_changes'
            ? 'ההעדפות שנחשפו כבר תואמות את הפרופיל — אין מה לעדכן.'
            : 'אין עדיין נתוני היכרות עם העדפות למועמד/ת.'}
        </p>
      ) : (
        <div className="space-y-3">
          {proposal.data.basedOn && (
            <p className="text-xs text-ink-muted num">
              מבוסס על הסשן האחרון: {proposal.data.basedOn.likes} מתאים · {proposal.data.basedOn.rejects} דחיות
            </p>
          )}
          <ul className="space-y-2 max-h-[45vh] overflow-y-auto">
            {changes.map((c) => (
              <li key={c.key}>
                <label className="flex items-start gap-2.5 rounded-md border border-border p-2.5 cursor-pointer hover:bg-bg-hover">
                  <input
                    type="checkbox"
                    className="mt-1 accent-brand"
                    checked={checked.has(c.key)}
                    onChange={() => {
                      const next = new Set(checked);
                      if (next.has(c.key)) next.delete(c.key);
                      else next.add(c.key);
                      setAccepted(next);
                    }}
                  />
                  <span className="min-w-0 text-sm">
                    <span className="font-medium text-ink">{c.label}</span>
                    <span className="flex items-center gap-1.5 text-xs mt-0.5 flex-wrap">
                      <span className="text-ink-subtle line-through">{c.currentDisplay}</span>
                      <ArrowLeft className="h-3 w-3 text-ink-faint shrink-0" />
                      <span className="text-brand-700 font-medium">{c.proposedDisplay}</span>
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}

export function DiscoveryRankingSection({ internalCandidateId }: { internalCandidateId: string }) {
  const [applyOpen, setApplyOpen] = useState(false);
  const ranking = useQuery({
    queryKey: ['discovery-ranking', internalCandidateId],
    queryFn: () => getPreferenceRanking(internalCandidateId),
  });

  if (ranking.isLoading) {
    return <div className="flex justify-center py-10"><Spinner className="h-6 w-6 text-brand" /></div>;
  }
  if (ranking.isError) {
    return (
      <ErrorState
        description={(ranking.error as Error).message}
        onRetry={() => ranking.refetch()}
      />
    );
  }
  const data = ranking.data;
  if (!data) return null;

  if (!data.available) {
    return (
      <Card className="p-6">
        <EmptyState
          title="עדיין אין נתוני היכרות"
          description={
            data.reason === 'no_sessions'
              ? 'צרו קישור בטאב "היכרות חכמה" ושלחו למועמד/ת — אחרי כמה החלקות הדירוג כאן יתמלא.'
              : 'הקישור נוצר אבל המועמד/ת עדיין לא החליק/ה על כרטיסים. הדירוג יופיע אחרי ההחלקות הראשונות.'
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardBody className="flex items-start gap-3 py-4">
          <Sparkles className="h-5 w-5 text-brand shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-xs text-ink-muted num">
              מבוסס על {data.signals.likes} סימוני "מתאים" ו-{data.signals.rejects} דחיות מהיכרות חכמה
              {!data.semanticActive && ' · התאמה סמנטית כבויה — הדירוג לפי מנוע בלבד'}
            </p>
            {data.learnedSummary && (
              <p className="text-sm text-ink leading-relaxed">{data.learnedSummary}</p>
            )}
            {(data.positiveSignals.length > 0 || data.negativeSignals.length > 0) && (
              <div className="flex flex-wrap gap-1.5">
                {data.positiveSignals.map((s) => (
                  <Badge key={`p-${s}`} tone="success">נמשך/ת ל: {s}</Badge>
                ))}
                {data.negativeSignals.map((s) => (
                  <Badge key={`n-${s}`} tone="danger">נרתע/ת מ: {s}</Badge>
                ))}
              </div>
            )}
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0"
            leftIcon={<UserCog className="h-3.5 w-3.5" />}
            onClick={() => setApplyOpen(true)}
          >
            החל על הפרופיל
          </Button>
        </CardBody>
      </Card>

      {applyOpen && (
        <ApplyToProfileDialog
          internalCandidateId={internalCandidateId}
          onClose={() => setApplyOpen(false)}
        />
      )}

      {data.rows.length === 0 ? (
        <Card className="p-6">
          <EmptyState title="אין מועמדים זמינים לדירוג" description="המאגר הפעיל ריק או שכולם חסומים למועמד/ת." />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {data.rows.map((row) => (
              <RankingRow key={row.externalCandidateId} row={row} internalCandidateId={internalCandidateId} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
