// ═══════════════════════════════════════════════════════════
// TraitWizard — the public opening questionnaire of "היכרות חכמה".
// Renders whatever question set the server produced (AI-personalized
// or static); answers are mapped into a TraitPicksPayload. The server
// re-validates everything against the vocabulary — this component is
// pure UX.
// ═══════════════════════════════════════════════════════════

import { useState } from 'react';
import { Button } from '@/components/ui/primitives';
import type { MeetWizard, TraitPicksPayload, WizardQuestion } from '@/services/api/discovery';

interface Props {
  wizard: MeetWizard;
  submitting: boolean;
  onSubmit: (picks: TraitPicksPayload) => void;
}

type Answers = Record<string, string[] | { min: number; max: number } | string>;

function buildPicks(questions: WizardQuestion[], answers: Answers): TraitPicksPayload {
  const picks: TraitPicksPayload = {};
  for (const q of questions) {
    const answer = answers[q.id];
    if (answer === undefined) continue;

    if (q.mapsTo === 'ageRange' && typeof answer === 'object' && !Array.isArray(answer)) {
      picks.ageMin = answer.min;
      picks.ageMax = answer.max;
    } else if (q.mapsTo === 'regions' && Array.isArray(answer)) {
      picks.regions = answer;
    } else if (q.mapsTo.startsWith('openness.')) {
      const key = q.mapsTo.slice('openness.'.length);
      const v = Array.isArray(answer) ? answer[0] : answer;
      if (v === 'yes' || v === 'no') {
        picks.openness = { ...picks.openness, [key]: v === 'yes' };
      }
    } else if (q.mapsTo.startsWith('soft:') && Array.isArray(answer) && answer.length > 0) {
      const field = q.mapsTo.slice('soft:'.length);
      picks.softPreferences = [
        ...(picks.softPreferences ?? []),
        ...answer.map((value) => ({ field, value, importance: 'important' })),
      ];
    } else if (q.mapsTo === 'freeText' && typeof answer === 'string' && answer.trim()) {
      picks.freeText = answer.trim();
    }
  }
  return picks;
}

function AgeRangeInput({
  question,
  value,
  onChange,
}: {
  question: WizardQuestion;
  value: { min: number; max: number };
  onChange: (v: { min: number; max: number }) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-4">
      <label className="flex flex-col items-center gap-1 text-sm text-ink-muted">
        מגיל
        <input
          type="number"
          inputMode="numeric"
          min={16}
          max={120}
          value={value.min}
          onChange={(e) => onChange({ ...value, min: Number(e.target.value) })}
          className="num w-20 h-12 text-center text-lg rounded-lg border border-border bg-bg-card focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </label>
      <span className="text-ink-subtle mt-5">—</span>
      <label className="flex flex-col items-center gap-1 text-sm text-ink-muted">
        עד גיל
        <input
          type="number"
          inputMode="numeric"
          min={16}
          max={120}
          value={value.max}
          onChange={(e) => onChange({ ...value, max: Number(e.target.value) })}
          className="num w-20 h-12 text-center text-lg rounded-lg border border-border bg-bg-card focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </label>
      {question.options.length === 0 && null}
    </div>
  );
}

export function TraitWizard({ wizard, submitting, onSubmit }: Props) {
  const questions = wizard.questions;
  const [stepIdx, setStepIdx] = useState(0);
  const [answers, setAnswers] = useState<Answers>(() => {
    const init: Answers = {};
    for (const q of questions) {
      if (q.mapsTo === 'ageRange') {
        const min = Number(q.options[0]?.value) || 20;
        const max = Number(q.options[1]?.value) || 35;
        init[q.id] = { min, max };
      }
    }
    return init;
  });

  const q = questions[stepIdx];
  if (!q) return null;
  const isLast = stepIdx === questions.length - 1;

  const toggleOption = (value: string) => {
    const current = (answers[q.id] as string[] | undefined) ?? [];
    const next = q.type === 'single'
      ? [value]
      : current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
    setAnswers((a) => ({ ...a, [q.id]: next }));
  };

  const selected = (answers[q.id] as string[] | undefined) ?? [];

  const advance = () => {
    if (isLast) onSubmit(buildPicks(questions, answers));
    else setStepIdx((i) => i + 1);
  };

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* progress dots */}
      <div className="flex justify-center gap-2" aria-label={`שאלה ${stepIdx + 1} מתוך ${questions.length}`}>
        {questions.map((_, i) => (
          <span
            key={i}
            className={`h-2 rounded-full transition-all ${i === stepIdx ? 'w-6 bg-brand' : 'w-2 bg-border-strong'}`}
          />
        ))}
      </div>

      <h2 className="text-xl font-semibold text-ink text-center leading-snug">{q.question}</h2>

      {q.mapsTo === 'ageRange' ? (
        <AgeRangeInput
          question={q}
          value={(answers[q.id] as { min: number; max: number }) ?? { min: 20, max: 35 }}
          onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
        />
      ) : q.mapsTo === 'freeText' ? (
        <textarea
          value={(answers[q.id] as string) ?? ''}
          onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
          maxLength={300}
          rows={3}
          placeholder="אפשר לכתוב כאן חופשי..."
          className="w-full rounded-lg border border-border bg-bg-card p-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
        />
      ) : (
        <div className="flex flex-wrap justify-center gap-2">
          {q.options.map((opt) => {
            const active = selected.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggleOption(opt.value)}
                aria-pressed={active}
                className={`min-h-[44px] px-4 py-2 rounded-full border text-sm font-medium transition-colors ${
                  active
                    ? 'bg-brand text-white border-brand'
                    : 'bg-bg-card text-ink border-border hover:bg-bg-hover'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Button size="lg" onClick={advance} loading={submitting && isLast} className="w-full">
          {isLast ? 'סיימתי — בואו נראה הצעות' : 'המשך'}
        </Button>
        {stepIdx > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setStepIdx((i) => i - 1)} className="w-full">
            חזרה
          </Button>
        )}
      </div>
    </div>
  );
}
