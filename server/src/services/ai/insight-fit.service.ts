// ═══════════════════════════════════════════════════════════
// ShadchanAI — Insight-Fit (heuristic, advisory ⭐)
//
// Given an internal candidate's LEARNED insight (positive/negative
// signals produced by candidate-learning.service) and an external
// candidate's profile, decide whether the external ALIGNS with what
// the candidate responded well to, CONFLICTS with a learned rejection
// pattern, or is NEUTRAL. Surfaced as a ⭐ / ⚠ badge on match lists.
//
// This is a keyword-overlap heuristic — deliberately cheap and offline
// (no AI call). The learned signals are free Hebrew text; we match a
// signal to a profile when their salient tokens overlap, and hand the
// operator the raw signal that triggered it so THEY judge. A future
// phase can swap computeFit() for a semantic/AI scorer without touching
// the callers. It NEVER changes the deterministic match score.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { CandidateInsight, ExternalCandidate, type ICandidateInsight } from '../../models/index.js';

export type InsightFitTier = 'aligned' | 'conflict' | 'neutral';

export interface InsightFit {
  tier: InsightFitTier;
  /** The learned signal (Hebrew) that triggered the tier — shown to the operator. */
  reason?: string;
  /** The insight's own confidence (0-1). Low → the badge is faint/omitted client-side. */
  confidence: number;
}

const NEUTRAL: InsightFit = { tier: 'neutral', confidence: 0 };

// Below this the learning is too thin to flag anything — stay silent
// rather than show noise from one or two data points.
const MIN_CONFIDENCE = 0.2;
const MIN_SUGGESTIONS = 2;

// Hebrew/English function words that must never count as an overlap.
const STOPWORDS = new Set([
  'של', 'עם', 'על', 'את', 'זה', 'זו', 'הוא', 'היא', 'הם', 'הן', 'לא', 'כן', 'גם',
  'אבל', 'או', 'כי', 'אם', 'יותר', 'פחות', 'מאוד', 'רק', 'עוד', 'כל', 'יש', 'אין',
  'היה', 'הייתה', 'להיות', 'אחד', 'אחת', 'שני', 'כמו', 'אצל', 'בין', 'לפי', 'תוך',
  'הצעה', 'הצעות', 'מועמד', 'מועמדת', 'שדכן', 'צד', 'וגם', 'שהוא', 'שהיא', 'להם',
  'and', 'the', 'for', 'with', 'was', 'are', 'not', 'but', 'has', 'her', 'his',
]);

// Hebrew attaches particles (ב/ה/ו/ל/מ/כ/ש) as a single leading letter, so
// "במרכז" / "המרכז" / "מרכז" are the same root written three ways. Strip ONE
// such prefix (when ≥3 letters remain) so keyword overlap actually fires —
// both the signal and the profile get the same normalization, so a stray
// over-strip still collides on the shared root rather than silently missing.
const HE_PREFIXES = new Set(['ב', 'ה', 'ו', 'ל', 'מ', 'כ', 'ש']);
function normalizeToken(w: string): string {
  if (w.length >= 4 && HE_PREFIXES.has(w[0]!)) return w.slice(1);
  return w;
}

/** Salient content tokens: length ≥ 3, not a stopword, prefix-normalized.
 *  Hebrew words are short, so 3 is the right floor; punctuation/digits are
 *  stripped to spaces first. */
function tokenize(text: string | undefined | null): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
      .map(normalizeToken)
      .filter((w) => w.length >= 3),
  );
}

/** A signal "matches" a profile when they share at least one salient token. */
function signalMatches(signalTokens: Set<string>, haystack: Set<string>): boolean {
  for (const t of signalTokens) if (haystack.has(t)) return true;
  return false;
}

// Loaded external fields we fold into the searchable haystack.
export interface ExternalProfileLite {
  city?: string;
  neighborhood?: string;
  originCity?: string;
  ethnicity?: string;
  familyBackground?: string;
  currentOccupation?: string;
  educationLevel?: string;
  about?: string;
  whatSeeking?: string;
  characterTraits?: string[];
  sectorGroup?: string;
  subSector?: string;
  personalStatus?: string;
  studyWorkDirection?: string;
  lifestyleTone?: string;
}

const EXTERNAL_FIELDS =
  'city neighborhood originCity ethnicity familyBackground currentOccupation educationLevel about whatSeeking characterTraits sectorGroup subSector personalStatus studyWorkDirection lifestyleTone';

// Enum → Hebrew-ish label maps aren't imported here to avoid a client-label
// dependency; the raw enum tokens (e.g. "dati_leumi") still overlap with
// signals that mention them, and the free-text fields carry the rest.
function haystackTokens(ext: ExternalProfileLite): Set<string> {
  const parts = [
    ext.city, ext.neighborhood, ext.originCity, ext.ethnicity, ext.familyBackground,
    ext.currentOccupation, ext.educationLevel, ext.about, ext.whatSeeking,
    ext.sectorGroup, ext.subSector, ext.personalStatus, ext.studyWorkDirection, ext.lifestyleTone,
    ...(ext.characterTraits ?? []),
  ].filter(Boolean).join(' ');
  return tokenize(parts);
}

/**
 * Pure heuristic core. Negative signals take precedence — a learned
 * rejection pattern that matches is a stronger message than a positive one.
 */
export function computeFit(insight: ICandidateInsight | null, ext: ExternalProfileLite): InsightFit {
  if (!insight) return NEUTRAL;
  if (insight.confidence < MIN_CONFIDENCE && (insight.basedOnSuggestions ?? 0) < MIN_SUGGESTIONS) {
    return NEUTRAL;
  }
  const haystack = haystackTokens(ext);
  if (haystack.size === 0) return { tier: 'neutral', confidence: insight.confidence };

  for (const sig of insight.negativeSignals ?? []) {
    if (signalMatches(tokenize(sig), haystack)) {
      return { tier: 'conflict', reason: sig, confidence: insight.confidence };
    }
  }
  for (const sig of insight.positiveSignals ?? []) {
    if (signalMatches(tokenize(sig), haystack)) {
      return { tier: 'aligned', reason: sig, confidence: insight.confidence };
    }
  }
  return { tier: 'neutral', confidence: insight.confidence };
}

export interface PairInput { internalCandidateId: string; externalCandidateId: string }
export interface PairFit extends PairInput { fit: InsightFit }

const MAX_PAIRS = 300;

/**
 * Batch fit for arbitrary internal×external pairs. Two grouped queries
 * (insights by internal, profiles by external) regardless of pair count,
 * so one call serves the detail page (1 pair), the discovery board (many
 * pairs, one internal), and the scan inbox (many internals).
 */
export async function insightFitForPairs(pairs: PairInput[]): Promise<PairFit[]> {
  const capped = pairs.slice(0, MAX_PAIRS).filter(
    (p) => Types.ObjectId.isValid(p.internalCandidateId) && Types.ObjectId.isValid(p.externalCandidateId),
  );
  if (capped.length === 0) return [];

  const internalIds = [...new Set(capped.map((p) => p.internalCandidateId))];
  const externalIds = [...new Set(capped.map((p) => p.externalCandidateId))];

  const [insights, externals] = await Promise.all([
    CandidateInsight.find({ candidateId: { $in: internalIds.map((id) => new Types.ObjectId(id)) } }).exec(),
    ExternalCandidate.find({ _id: { $in: externalIds.map((id) => new Types.ObjectId(id)) } })
      .select(EXTERNAL_FIELDS).lean().exec(),
  ]);

  const insightByInternal = new Map(insights.map((i) => [String(i.candidateId), i]));
  const extById = new Map(externals.map((e) => [String(e._id), e as unknown as ExternalProfileLite]));

  return capped.map((p) => ({
    ...p,
    fit: computeFit(
      insightByInternal.get(p.internalCandidateId) ?? null,
      extById.get(p.externalCandidateId) ?? {},
    ),
  }));
}
