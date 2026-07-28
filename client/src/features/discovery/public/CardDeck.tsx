// ═══════════════════════════════════════════════════════════
// CardDeck — the swipe surface of "היכרות חכמה". One card visible
// at a time; big button verdicts (deliberately no drag gestures —
// accessible, RTL-trivial, and a future swipe layer changes nothing
// in the API). Reject opens a bottom sheet asking WHY — that reason
// is the whole point of the feature.
// ═══════════════════════════════════════════════════════════

import { useState } from 'react';
import { Heart, X, ChevronLeft } from 'lucide-react';
import { Badge, Button, Card, CardBody } from '@/components/ui/primitives';
import { meetPhotoUrl, type DiscoveryCardDTO } from '@/services/api/discovery';

interface Props {
  token: string;
  cards: DiscoveryCardDTO[];
  rejectChips: string[];
  onVerdict: (cardId: string, verdict: 'like' | 'reject' | 'skip', reasonChips?: string[], reasonText?: string) => void;
  onDeckEmpty: () => void;
}

function DiscoveryCardView({ token, card }: { token: string; card: DiscoveryCardDTO }) {
  const facts: string[] = [];
  if (card.age !== undefined) facts.push(`גיל ${card.age}`);
  if (card.regionLabel) facts.push(card.regionLabel);
  if (card.height) facts.push(`${card.height} ס״מ`);

  return (
    <Card className="overflow-hidden">
      {card.hasPhoto && (
        <div className="h-44 bg-bg-subtle overflow-hidden">
          <img
            src={meetPhotoUrl(token, card.cardId)}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>
      )}
      <CardBody className="flex flex-col gap-3">
        {facts.length > 0 && (
          <p className="text-sm font-medium text-ink num">{facts.join(' · ')}</p>
        )}

        <div className="flex flex-wrap gap-1.5">
          {card.sectorGroupLabel && <Badge tone="brand">{card.sectorGroupLabel}</Badge>}
          {card.subSectorLabel && <Badge tone="neutral">{card.subSectorLabel}</Badge>}
          {card.personalStatusLabel && <Badge tone="info">{card.personalStatusLabel}</Badge>}
        </div>

        {(card.occupation || card.educationLevel) && (
          <p className="text-sm text-ink-muted">
            {[card.occupation, card.educationLevel].filter(Boolean).join(' · ')}
          </p>
        )}

        {card.summary && (
          <p className="text-sm text-ink leading-relaxed">{card.summary}</p>
        )}

        {card.highlights.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border">
            {card.highlights.map((h) => (
              <Badge key={h} tone="success">{h}</Badge>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function RejectReasonSheet({
  chips,
  submitting,
  onSubmit,
  onCancel,
}: {
  chips: string[];
  submitting: boolean;
  onSubmit: (reasonChips: string[], reasonText: string) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onCancel}>
      <div
        className="w-full max-w-md bg-bg-card rounded-t-2xl p-5 flex flex-col gap-4 pb-8"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="למה לא מתאים?"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-border-strong" />
        <h3 className="text-lg font-semibold text-ink text-center">מה פחות התאים לך?</h3>
        <p className="text-xs text-ink-muted text-center -mt-2">
          התשובה עוזרת לנו להציע הצעות מדויקות יותר בסבב הבא
        </p>

        <div className="flex flex-wrap justify-center gap-2">
          {chips.map((chip) => {
            const active = selected.includes(chip);
            return (
              <button
                key={chip}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  setSelected((s) => (active ? s.filter((c) => c !== chip) : [...s, chip]))
                }
                className={`min-h-[40px] px-3 py-1.5 rounded-full border text-sm transition-colors ${
                  active
                    ? 'bg-danger text-white border-danger'
                    : 'bg-bg-card text-ink border-border hover:bg-bg-hover'
                }`}
              >
                {chip}
              </button>
            );
          })}
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={300}
          rows={2}
          placeholder="או במילים שלך... (לא חובה)"
          className="w-full rounded-lg border border-border bg-bg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
        />

        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            variant="danger"
            className="w-full"
            loading={submitting}
            onClick={() => onSubmit(selected, text.trim())}
          >
            שליחה
          </Button>
          <Button variant="ghost" size="sm" className="w-full" onClick={() => onSubmit([], '')}>
            דילוג על הסיבה
          </Button>
        </div>
      </div>
    </div>
  );
}

export function CardDeck({ token, cards, rejectChips, onVerdict, onDeckEmpty }: Props) {
  const [idx, setIdx] = useState(0);
  const [rejecting, setRejecting] = useState(false);

  const card = cards[idx];
  if (!card) return null;

  const advance = () => {
    if (idx + 1 >= cards.length) onDeckEmpty();
    else setIdx((i) => i + 1);
  };

  const decide = (verdict: 'like' | 'reject' | 'skip', chips?: string[], text?: string) => {
    onVerdict(card.cardId, verdict, chips, text);
    setRejecting(false);
    advance();
  };

  return (
    <div className="flex flex-col gap-4 w-full">
      <p className="text-center text-xs text-ink-muted num">
        כרטיס {idx + 1} מתוך {cards.length}
      </p>

      <DiscoveryCardView token={token} card={card} />

      <div className="grid grid-cols-2 gap-3">
        <Button
          size="lg"
          variant="secondary"
          className="h-14 text-base border-danger/40 text-danger hover:bg-red-50"
          leftIcon={<X className="h-5 w-5" />}
          onClick={() => setRejecting(true)}
        >
          לא מתאים
        </Button>
        <Button
          size="lg"
          className="h-14 text-base"
          leftIcon={<Heart className="h-5 w-5" />}
          onClick={() => decide('like')}
        >
          מתאים לי
        </Button>
      </div>

      <button
        type="button"
        onClick={() => decide('skip')}
        className="mx-auto inline-flex items-center gap-1 text-xs text-ink-subtle hover:text-ink-muted min-h-[44px] px-4"
      >
        קשה לי להחליט — הבא
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>

      {rejecting && (
        <RejectReasonSheet
          chips={rejectChips}
          submitting={false}
          onSubmit={(chips, text) => decide('reject', chips.length ? chips : undefined, text || undefined)}
          onCancel={() => setRejecting(false)}
        />
      )}
    </div>
  );
}
