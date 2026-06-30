// ═══════════════════════════════════════════════════════════
// Deterministic explanation builder.
//
// Produces a concise, structured explanation for a compatibility
// row based PURELY on engine output (and persisted suggestion +
// review state). Never calls the AI.
//
// The UI uses these strings as the primary explanation; AI
// commentary is supplementary and labeled separately.
//
// Hebrew strings: matches the rest of the operator-facing UI.
// ═══════════════════════════════════════════════════════════

import type { IMatchSuggestion, IPairReview } from '../../models/index.js';
import type { MatchResult } from '../matching/matching.types.js';

export interface DeterministicExplanation {
  /** One-line headline shown in the table row */
  primary: string;
  /** Positive rationale (engine strengths + dimension strengths) */
  positives: string[];
  /** Negative rationale (blockers + attention points + outcome reasons) */
  negatives: string[];
  /** Soft warnings (low confidence, missing data, soft blockers) */
  warnings: string[];
  /** Operator overlay summary (if any prior manual review or outcome) */
  manualOverlay?: string;
}

const SUITABLE_SCORE_MIN = 70;
const SUITABLE_CONFIDENCE_MIN = 60;

export function buildDeterministicExplanation(args: {
  bucket: 'suitable' | 'blocked' | 'weak' | 'forced' | 'historical';
  result: MatchResult;
  suggestion?: IMatchSuggestion;
  review?: IPairReview;
  external?: Record<string, unknown>;
}): DeterministicExplanation {
  const { bucket, result, suggestion, review } = args;

  const positives: string[] = [];
  const negatives: string[] = [];
  const warnings: string[] = [];

  // Always include engine-emitted strengths/attention as raw inputs.
  for (const s of result.strengths) positives.push(s);
  for (const a of result.attentionPoints) warnings.push(a);

  // Convert blockers into structured language by severity.
  for (const b of result.blockers) {
    if (b.severity === 'hard_non_overridable' || b.severity === 'hard_overridable') {
      negatives.push(b.message);
    } else {
      warnings.push(b.message);
    }
  }

  let primary = '';
  switch (bucket) {
    case 'suitable':
      primary = `מתאים — ציון ${result.matchScore}, ביטחון ${result.confidenceScore}`;
      // Highlight the top 2 dimensions that contributed most.
      for (const dim of [...result.scoreBreakdown]
        .sort((a, b) => b.weightedScore - a.weightedScore)
        .slice(0, 2)) {
        positives.push(`${dimensionLabel(dim.dimension)}: ${dim.detail}`);
      }
      break;

    case 'weak': {
      const reasons: string[] = [];
      if (result.matchScore < SUITABLE_SCORE_MIN) reasons.push(`ציון נמוך (${result.matchScore})`);
      if (result.confidenceScore < SUITABLE_CONFIDENCE_MIN) reasons.push(`ביטחון נמוך (${result.confidenceScore})`);
      if (result.matchType === 'risky') reasons.push('סווג כסיכון');
      primary = `התאמה חלשה — ${reasons.join(', ') || 'נתונים חסרים או דירוג נמוך'}`;
      // Surface low-scoring dimensions.
      for (const dim of [...result.scoreBreakdown]
        .filter((d) => d.score < 50)
        .sort((a, b) => a.weightedScore - b.weightedScore)
        .slice(0, 2)) {
        warnings.push(`${dimensionLabel(dim.dimension)}: ${dim.detail}`);
      }
      break;
    }

    case 'blocked': {
      const hard = result.blockers.find(
        (b) => b.severity === 'hard_non_overridable' || b.severity === 'hard_overridable',
      );
      if (hard) {
        const overridability = hard.severity === 'hard_non_overridable'
          ? 'חסום — לא ניתן לעקוף'
          : 'חסום — ניתן לעקוף עם נימוק';
        primary = `${overridability}: ${hard.message}`;
      } else {
        primary = 'חסום על ידי המנוע';
      }
      break;
    }

    case 'forced':
      primary = `הצעה כפויה — ${suggestion?.status ?? 'פעילה'}`;
      if (suggestion?.overrideReasons?.length) {
        for (const r of suggestion.overrideReasons.slice(0, 3)) negatives.push(r);
      }
      break;

    case 'historical': {
      const status = suggestion?.status ?? 'unknown';
      primary = historicalLabel(status);
      if (suggestion?.closeReason) negatives.push(`סיבת סגירה: ${suggestion.closeReason}`);
      if (suggestion?.sideAResponse?.declineReason) {
        negatives.push(`צד א׳ סירב: ${suggestion.sideAResponse.declineReason}`);
      }
      if (suggestion?.sideBResponse?.declineReason) {
        negatives.push(`צד ב׳ סירב: ${suggestion.sideBResponse.declineReason}`);
      }
      break;
    }
  }

  const manualOverlay = buildManualOverlay(review);

  return {
    primary,
    positives: dedupe(positives),
    negatives: dedupe(negatives),
    warnings: dedupe(warnings),
    manualOverlay,
  };
}

function buildManualOverlay(review: IPairReview | undefined): string | undefined {
  if (!review) return undefined;
  const status = manualStatusLabel(review.manualStatus);
  const reason = review.outcomeReason ?? review.operatorReason;
  return reason ? `${status}: ${reason}` : status;
}

function manualStatusLabel(s: string): string {
  switch (s) {
    case 'suitable':              return 'הופעל ידני: מתאים';
    case 'not_suitable':          return 'הופעל ידני: לא מתאים';
    case 'review_later':          return 'הופעל ידני: לבדוק מאוחר יותר';
    case 'forced':                return 'הופעל ידני: כפוי';
    case 'rejected_after_contact': return 'הופעל ידני: נכשל לאחר קשר';
    default:                       return s;
  }
}

function historicalLabel(status: string): string {
  switch (status) {
    case 'declined_side_a': return 'נדחה — צד א׳ סירב';
    case 'declined_side_b': return 'נדחה — צד ב׳ סירב';
    case 'dating':          return 'בקשרי היכרות';
    case 'expired':         return 'פג תוקף';
    case 'closed':          return 'סגור';
    default:                return `היסטורי (${status})`;
  }
}

function dimensionLabel(d: string): string {
  switch (d) {
    case 'age':                 return 'גיל';
    case 'sector':              return 'מגזר';
    case 'lifestyle':           return 'אורח חיים';
    case 'study_work':          return 'לימודים/עבודה';
    case 'location':            return 'מיקום';
    case 'mutual_expectations': return 'ציפיות הדדיות';
    case 'life_stage':          return 'שלב חיים';
    case 'flexibility':         return 'גמישות';
    default:                    return d;
  }
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (!s) continue;
    const k = s.trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}
