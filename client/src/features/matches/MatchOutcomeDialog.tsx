// ═══════════════════════════════════════════════════════════
// MatchOutcomeDialog — the "סגור" flow that feeds the learning loop.
//
// Two steps:
//   1. Choose what actually happened with the suggestion.
//   2. Capture the WHY. For "לא התאים" this is a per-side free text
//      ("why not for him", "why not for her") — each side's reason is
//      persisted on its declineReason, which the candidate-learning
//      agent reads to refine future match direction for THAT candidate.
//
// A happy outcome (יוצאים / התארסו / התחתנו) just records the outcome
// (+ optional note); no reasons are fabricated. Never touches the score.
// ═══════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Textarea } from '@/components/ui/primitives';

export type MatchOutcome = 'dating' | 'engaged' | 'married' | 'not_suitable';

export interface OutcomePayload {
  outcome: MatchOutcome;
  note?: string;
  sideAReason?: string;
  sideBReason?: string;
}

const OUTCOMES: { key: MatchOutcome; emoji: string; label: string; desc: string; happy: boolean }[] = [
  { key: 'dating', emoji: '💚', label: 'יוצאים', desc: 'ההצעה צלחה — הם בקשר / יוצאים', happy: true },
  { key: 'engaged', emoji: '💍', label: 'התארסו', desc: 'מזל טוב — הגיעו לאירוסין', happy: true },
  { key: 'married', emoji: '🎊', label: 'התחתנו', desc: 'מזל טוב — הגיעו לחתונה', happy: true },
  { key: 'not_suitable', emoji: '✖️', label: 'לא התאים', desc: 'לא צלח — נרשום למה כדי שהמערכת תלמד', happy: false },
];

export function MatchOutcomeDialog({
  open, internalName, externalName, loading, onClose, onSubmit,
}: {
  open: boolean;
  internalName: string;
  externalName: string;
  loading?: boolean;
  onClose: () => void;
  onSubmit: (payload: OutcomePayload) => void;
}) {
  const [outcome, setOutcome] = useState<MatchOutcome | null>(null);
  const [note, setNote] = useState('');
  const [sideAReason, setSideAReason] = useState('');
  const [sideBReason, setSideBReason] = useState('');

  // Fresh state on every open — an outcome belongs to one decision only.
  useEffect(() => {
    if (!open) return;
    setOutcome(null);
    setNote('');
    setSideAReason('');
    setSideBReason('');
  }, [open]);

  // ── Step 1: choose the outcome ─────────────────────────────
  if (!outcome) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="סגירת הצעה — מה קרה?"
        description="בחר מה עלה בגורל ההצעה. הבחירה עוזרת למערכת ללמוד את המועמדים ולדייק הצעות הבאות."
        secondaryAction={{ label: 'ביטול', onClick: onClose }}
      >
        <div className="space-y-2">
          {OUTCOMES.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setOutcome(o.key)}
              className="w-full flex items-start gap-3 rounded-lg border border-border bg-bg-card p-3 text-start hover:bg-bg-hover hover:border-brand-300 transition-colors"
            >
              <span className="text-xl leading-none mt-0.5">{o.emoji}</span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{o.label}</span>
                <span className="block text-xs text-ink-muted mt-0.5">{o.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </Dialog>
    );
  }

  // ── Step 2: capture the WHY ────────────────────────────────
  const meta = OUTCOMES.find((o) => o.key === outcome)!;
  const notSuitable = outcome === 'not_suitable';
  const canConfirm = !notSuitable || Boolean(sideAReason.trim() || sideBReason.trim() || note.trim());

  const submit = () => onSubmit({
    outcome,
    note: note.trim() || undefined,
    sideAReason: notSuitable ? (sideAReason.trim() || undefined) : undefined,
    sideBReason: notSuitable ? (sideBReason.trim() || undefined) : undefined,
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={<span className="flex items-center gap-2">{meta.emoji} {meta.label}</span>}
      description={notSuitable
        ? 'פרט למה זה לא התאים לכל צד. הטקסט נשמר על המועמד וה-AI לומד ממנו — ככל שתפרט יותר, ההצעות הבאות ידויקו.'
        : 'אפשר להוסיף הערה קצרה (רשות). היא נשמרת ביומן הלמידה של המועמד.'}
      primaryAction={{
        label: 'סגור הצעה',
        onClick: submit,
        loading,
        disabled: !canConfirm,
        variant: notSuitable ? 'danger' : 'primary',
      }}
      secondaryAction={{ label: 'חזרה', onClick: () => setOutcome(null) }}
    >
      {notSuitable ? (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">למה לא התאים ל{internalName || 'צד הפנימי'}?</label>
            <Textarea
              rows={2}
              value={sideAReason}
              onChange={(e) => setSideAReason(e.target.value)}
              placeholder="למשל: מעדיף/ה גיל צעיר יותר · חיפש/ה רקע לימודי אחר"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">למה לא התאים ל{externalName || 'צד החיצוני'}?</label>
            <Textarea
              rows={2}
              value={sideBReason}
              onChange={(e) => setSideBReason(e.target.value)}
              placeholder="למשל: רצה/רצתה מישהו/י מאזור אחר · ציפייה שונה לגבי גודל משפחה"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">הערה כללית (רשות)</label>
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="הקשר נוסף על הסגירה"
            />
          </div>
          {!canConfirm && (
            <div className="text-[11px] text-ink-faint">מלא לפחות שדה אחד כדי שהמערכת תוכל ללמוד.</div>
          )}
        </div>
      ) : (
        <Textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="הערה קצרה (רשות) — למשל איך התקדם הקשר"
        />
      )}
    </Dialog>
  );
}
