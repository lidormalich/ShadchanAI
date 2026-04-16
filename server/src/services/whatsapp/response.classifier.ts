// ═══════════════════════════════════════════════════════════
// Inbound reply classifier (Phase 6).
//
// Deterministic first-pass on Hebrew + English reply text; maps
// to the side-response enum accepted / declined / considering.
// When regex confidence is low, callers can fall back to the AI
// classifyMessage service — but this module stays sync + offline.
//
// The output is advisory-by-construction; the final persisted
// status on the match is explicit and auditable (see
// match.service.applyInboundResponse).
// ═══════════════════════════════════════════════════════════

export type ResponseClassification = 'accepted' | 'declined' | 'considering';

export interface ClassifierOutput {
  status: ResponseClassification;
  confidence: number; // 0..1
  matchedKeywords: string[];
}

// Hebrew + English keyword lists. Order is not significant.
// Kept broad on purpose: false negatives (→ considering) are
// cheap; the operator acknowledges on the match detail page.
const ACCEPT_PATTERNS = [
  // Hebrew
  /\bכן\b/, /מסכים/, /מסכימה/, /מתאים/, /מתאימה/,
  /אפשר להתקדם/, /אפשר לצאת/, /אני בעד/, /נשמע טוב/,
  /נפגש/, /נפגשים/, /מעוניין/, /מעוניינת/,
  /אני רוצה להמשיך/, /נמשיך/, /בשמחה/,
  // English
  /\byes\b/i, /\bsure\b/i, /\bok(?:ay)?\b/i, /interested/i,
  /sounds good/i, /let'?s proceed/i, /go ahead/i, /i'?m in\b/i,
];

const DECLINE_PATTERNS = [
  // Hebrew
  /\bלא\b/, /לא מתאים/, /לא מתאימה/, /לא מעוניין/, /לא מעוניינת/,
  /לא רלוונטי/, /לא לעכשיו/, /לא אני/, /לצערי לא/,
  /מוותר/, /מוותרת/, /מעדיף לא/, /מעדיפה לא/, /לדלג/,
  // English
  /\bno\b/i, /not interested/i, /pass\b/i, /decline/i,
  /unfortunately not/i, /not a (?:good )?fit/i, /i'?ll pass/i,
];

const CONSIDERING_PATTERNS = [
  // Hebrew
  /אחשוב/, /אני חושב/, /אני חושבת/, /צריך לחשוב/, /צריכה לחשוב/,
  /אחזור אליך/, /אחזור בהמשך/, /לא בטוח/, /לא בטוחה/, /צריך זמן/,
  // English
  /thinking/i, /not sure/i, /let me think/i, /get back to you/i,
  /need time/i, /maybe\b/i,
];

/**
 * Score a message body against the three intent lists.
 *
 * Confidence heuristic:
 *   - single strong match → 0.65
 *   - ≥2 matches on same intent → 0.85
 *   - conflict (accept + decline matches both present) → 0.4 on the stronger,
 *     operator will see a "classifier=regex, confidence low" in audit metadata
 *     and may override.
 */
export function classifyResponse(rawBody: string | undefined): ClassifierOutput {
  if (!rawBody || rawBody.trim().length === 0) {
    return { status: 'considering', confidence: 0, matchedKeywords: [] };
  }

  const body = rawBody.trim();

  const acceptHits = matchAll(body, ACCEPT_PATTERNS);
  const declineHits = matchAll(body, DECLINE_PATTERNS);
  const considerHits = matchAll(body, CONSIDERING_PATTERNS);

  const scores: Array<{ status: ResponseClassification; hits: string[] }> = [
    { status: 'accepted', hits: acceptHits },
    { status: 'declined', hits: declineHits },
    { status: 'considering', hits: considerHits },
  ];
  scores.sort((a, b) => b.hits.length - a.hits.length);

  const top = scores[0]!;
  const second = scores[1]!;

  if (top.hits.length === 0) {
    return { status: 'considering', confidence: 0, matchedKeywords: [] };
  }

  let confidence: number;
  if (top.hits.length >= 2 && second.hits.length === 0) {
    confidence = 0.85;
  } else if (top.hits.length >= 1 && second.hits.length === 0) {
    confidence = 0.65;
  } else if (top.hits.length > second.hits.length) {
    // Conflict but one side dominates slightly
    confidence = 0.4;
  } else {
    // Tie — fall back to considering so the operator reviews
    return { status: 'considering', confidence: 0.2, matchedKeywords: [...top.hits, ...second.hits] };
  }

  return { status: top.status, confidence, matchedKeywords: top.hits };
}

function matchAll(text: string, patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) hits.push(m[0]);
  }
  return hits;
}
