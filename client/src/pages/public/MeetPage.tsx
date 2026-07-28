// ═══════════════════════════════════════════════════════════
// MeetPage — the public /meet/:token page of "היכרות חכמה".
// Renders OUTSIDE the AppShell (no login, no sidebar): a mobile-first
// state machine —
//   loading → invalid|expired|disabled
//           → intro → traits → swiping ⇄ refining → done
// Verdicts submit optimistically; alreadyRecorded responses are
// silently accepted (mobile double-taps are normal, not errors).
// ═══════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Heart, Sparkles, ShieldCheck, Clock } from 'lucide-react';
import { Button, Card, CardBody, Spinner } from '@/components/ui/primitives';
import { TraitWizard } from '@/features/discovery/public/TraitWizard';
import { CardDeck } from '@/features/discovery/public/CardDeck';
import {
  getMeetState,
  submitTraits,
  getNextBatch,
  submitVerdict,
  finishMeet,
  type DiscoveryCardDTO,
  type MeetState,
  type MeetFinishResult,
  type TraitPicksPayload,
} from '@/services/api/discovery';

type Phase =
  | { name: 'loading' }
  | { name: 'gate'; state: 'invalid' | 'expired' | 'disabled' }
  | { name: 'intro' }
  | { name: 'traits' }
  | { name: 'refining' }
  | { name: 'swiping'; cards: DiscoveryCardDTO[] }
  | { name: 'done'; result?: MeetFinishResult };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg-subtle flex flex-col items-center px-4 py-6">
      <div className="w-full max-w-md flex-1 flex flex-col justify-center gap-6">
        {children}
      </div>
      <p className="text-[11px] text-ink-faint pt-6">ShadchanAI · היכרות חכמה</p>
    </div>
  );
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardBody className="flex flex-col items-center gap-4 text-center py-8">{children}</CardBody>
    </Card>
  );
}

export function MeetPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [meet, setMeet] = useState<MeetState | null>(null);
  const [submittingTraits, setSubmittingTraits] = useState(false);
  // Deck completion is decided by the SERVER's batchComplete/exhausted
  // flags; this ref tracks the pending verdict submissions so "next
  // batch" waits for them.
  const pendingVerdicts = useRef<Promise<unknown>[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await getMeetState(token);
        if (cancelled) return;
        setMeet(state);
        if (state.state !== 'ok') {
          setPhase({ name: 'gate', state: state.state as 'invalid' | 'expired' | 'disabled' });
        } else if (state.step === 'done') {
          setPhase({ name: 'done' });
        } else if (state.step === 'swiping' && state.currentBatch?.length) {
          setPhase({ name: 'swiping', cards: state.currentBatch });
        } else if (state.step === 'swiping') {
          setPhase({ name: 'refining' });
          void loadBatch();
        } else {
          setPhase({ name: 'intro' });
        }
      } catch {
        if (!cancelled) setPhase({ name: 'gate', state: 'invalid' });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadBatch = useCallback(async () => {
    setPhase({ name: 'refining' });
    try {
      // Let in-flight verdicts land first so the server refines on them.
      await Promise.allSettled(pendingVerdicts.current);
      pendingVerdicts.current = [];
      const batch = await getNextBatch(token);
      if (batch.state !== 'ok') {
        setPhase({ name: 'gate', state: batch.state as 'invalid' | 'expired' | 'disabled' });
        return;
      }
      if (!batch.cards?.length) {
        const result = await finishMeet(token);
        setPhase({ name: 'done', result });
        return;
      }
      setPhase({ name: 'swiping', cards: batch.cards });
    } catch {
      setPhase({ name: 'gate', state: 'invalid' });
    }
  }, [token]);

  const handleVerdict = useCallback(
    (cardId: string, verdict: 'like' | 'reject' | 'skip', reasonChips?: string[], reasonText?: string) => {
      // Optimistic: the deck advances immediately; failures are absorbed
      // (the card just stays unanswered server-side and is re-served).
      const p = submitVerdict(token, { cardId, verdict, reasonChips, reasonText }).catch(() => undefined);
      pendingVerdicts.current.push(p);
    },
    [token],
  );

  const handleTraits = useCallback(async (picks: TraitPicksPayload) => {
    setSubmittingTraits(true);
    try {
      const res = await submitTraits(token, picks);
      if (res.state !== 'ok') {
        setPhase({ name: 'gate', state: res.state as 'invalid' | 'expired' | 'disabled' });
        return;
      }
      await loadBatch();
    } catch {
      setPhase({ name: 'gate', state: 'invalid' });
    } finally {
      setSubmittingTraits(false);
    }
  }, [token, loadBatch]);

  const handleFinish = useCallback(async () => {
    setPhase({ name: 'refining' });
    try {
      await Promise.allSettled(pendingVerdicts.current);
      const result = await finishMeet(token);
      setPhase({ name: 'done', result });
    } catch {
      setPhase({ name: 'done' });
    }
  }, [token]);

  // ── Render ─────────────────────────────────────────────

  if (phase.name === 'loading') {
    return (
      <Shell>
        <div className="flex justify-center"><Spinner className="h-8 w-8 text-brand" /></div>
      </Shell>
    );
  }

  if (phase.name === 'gate') {
    return (
      <Shell>
        <CenterCard>
          <Clock className="h-10 w-10 text-ink-subtle" />
          <h1 className="text-xl font-semibold text-ink">
            {phase.state === 'expired' ? 'הקישור פג תוקף' : 'הקישור אינו זמין'}
          </h1>
          <p className="text-sm text-ink-muted leading-relaxed">
            {phase.state === 'expired'
              ? 'תוקף הקישור הסתיים. אפשר לפנות לשדכן/ית לקבלת קישור חדש.'
              : 'הקישור אינו פעיל. אם קיבלתם אותו מהשדכן/ית — בקשו קישור מעודכן.'}
          </p>
        </CenterCard>
      </Shell>
    );
  }

  if (phase.name === 'intro') {
    return (
      <Shell>
        <CenterCard>
          <div className="h-14 w-14 rounded-full bg-brand-50 flex items-center justify-center">
            <Heart className="h-7 w-7 text-brand" />
          </div>
          <h1 className="text-2xl font-bold text-ink">
            {meet?.firstName ? `שלום ${meet.firstName}!` : 'שלום!'}
          </h1>
          <p className="text-sm text-ink-muted leading-relaxed">
            הכנו עבורך חוויה קצרה שתעזור לנו להבין מה באמת מתאים לך.
            נשאל כמה שאלות קצרות, ואז נציג הצעות — על כל הצעה פשוט
            מסמנים אם היא מרגישה מתאימה או לא.
          </p>
          <div className="flex items-start gap-2 text-start bg-bg-subtle rounded-lg p-3">
            <ShieldCheck className="h-4 w-4 text-success shrink-0 mt-0.5" />
            <p className="text-xs text-ink-muted leading-relaxed">
              ההצעות מוצגות באופן אנונימי — בלי שמות ובלי פרטי קשר.
              הבחירות שלך נשמרות רק עבור השדכן/ית שלך.
            </p>
          </div>
          <Button size="lg" className="w-full" onClick={() => setPhase({ name: 'traits' })}>
            בואו נתחיל
          </Button>
        </CenterCard>
      </Shell>
    );
  }

  if (phase.name === 'traits') {
    return (
      <Shell>
        <Card>
          <CardBody className="py-8">
            {meet?.wizard ? (
              <TraitWizard wizard={meet.wizard} submitting={submittingTraits} onSubmit={handleTraits} />
            ) : (
              <div className="flex justify-center"><Spinner className="h-8 w-8 text-brand" /></div>
            )}
          </CardBody>
        </Card>
      </Shell>
    );
  }

  if (phase.name === 'refining') {
    return (
      <Shell>
        <CenterCard>
          <Sparkles className="h-9 w-9 text-brand animate-pulse" />
          <h2 className="text-lg font-semibold text-ink">רגע... לומדים מה חשוב לך</h2>
          <p className="text-sm text-ink-muted">מכינים את ההצעות הבאות</p>
          <Spinner className="h-6 w-6 text-brand" />
        </CenterCard>
      </Shell>
    );
  }

  if (phase.name === 'swiping') {
    return (
      <Shell>
        <CardDeck
          token={token}
          cards={phase.cards}
          rejectChips={meet?.rejectChips ?? []}
          onVerdict={handleVerdict}
          onDeckEmpty={() => void loadBatch()}
        />
        <button
          type="button"
          onClick={() => void handleFinish()}
          className="mx-auto text-xs text-ink-subtle hover:text-ink-muted min-h-[44px] px-4"
        >
          סיימתי לבינתיים
        </button>
      </Shell>
    );
  }

  // done
  const insights = phase.name === 'done' ? phase.result?.insights : undefined;
  return (
    <Shell>
      <CenterCard>
        <div className="h-14 w-14 rounded-full bg-green-50 flex items-center justify-center">
          <Heart className="h-7 w-7 text-success" />
        </div>
        <h1 className="text-xl font-bold text-ink">תודה רבה!</h1>
        {insights && (
          <p className="text-sm text-ink-muted num">
            סימנת {insights.liked} מתוך {insights.total} הצעות כמתאימות
          </p>
        )}
        {insights?.learnedSummary && (
          <div className="w-full text-start bg-brand-50 rounded-lg p-4 flex flex-col gap-2">
            <p className="text-xs font-semibold text-brand-700 flex items-center gap-1">
              <Sparkles className="h-3.5 w-3.5" />
              מה הבנו עליך
            </p>
            <p className="text-sm text-ink leading-relaxed">{insights.learnedSummary}</p>
            {insights.learnedSignals.length > 0 && (
              <ul className="text-xs text-ink-muted list-disc ps-4 flex flex-col gap-1">
                {insights.learnedSignals.map((s) => <li key={s}>{s}</li>)}
              </ul>
            )}
          </div>
        )}
        <p className="text-sm text-ink-muted leading-relaxed">
          הבחירות שלך הועברו לשדכן/ית ויעזרו למצוא הצעות מדויקות יותר.
          נחזור אליך כשיש משהו מתאים 💜
        </p>
      </CenterCard>
    </Shell>
  );
}
