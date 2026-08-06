// ═══════════════════════════════════════════════════════════
// CandidateVerdictBadge — the candidate's own swipe verdict from a
// "היכרות חכמה" session. Shared decoration for EVERY operator
// suggestion list (board rows, semantic rows, find-matches dialog,
// preference ranking) so the first-person signal is visible wherever
// a pair surfaces.
// ═══════════════════════════════════════════════════════════

import { Badge } from '@/components/ui/primitives';
import type { CandidateVerdict } from '@/services/api/pair-reviews';

export function CandidateVerdictBadge({ verdict }: { verdict?: CandidateVerdict }) {
  if (!verdict) return null;
  const tone = verdict.verdict === 'like' ? 'success'
    : verdict.verdict === 'reject' ? 'danger' : 'neutral';
  const text = verdict.verdict === 'like'
    ? 'המועמד/ת סימנ/ה: מתאים'
    : verdict.verdict === 'reject'
      ? `המועמד/ת דחה/תה${verdict.reasons.length ? `: ${verdict.reasons[0]}` : ''}`
      : 'המועמד/ת דילג/ה';
  return (
    <Badge tone={tone} title={verdict.reasons.join(' · ') || undefined}>
      {text}
    </Badge>
  );
}
