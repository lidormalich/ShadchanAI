// ═══════════════════════════════════════════════════════════
// ShadchanAI — Match AI explanation (persisted + staleness-aware)
//
// Generates the advisory AI explanation for a suggestion and PERSISTS
// it onto MatchSuggestion.aiExplanation so it survives restarts and is
// reused across operators — unlike the 5-minute in-memory AI cache.
//
// Refresh policy ("גם וגם"): the explanation is keyed on a hash of BOTH
//   - the two candidates' scoringHash (any profile change that affects
//     scoring), AND
//   - the engine outputs (matchScore / confidenceScore / matchType /
//     riskLevel).
// If any of those change, the stored explanation is stale → regenerate.
// On regeneration we diff the old vs new input snapshot and record WHICH
// inputs changed, so the UI can tell the operator why it refreshed.
//
// The engine is never bypassed; AI is advisory only.
// ═══════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import { AuditActionType, AuditEntityType } from '@shadchanai/shared';
import {
  MatchSuggestion,
  InternalCandidate,
  ExternalCandidate,
  type IMatchSuggestion,
} from '../../models/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import { explainMatch } from '../../services/ai/ai.service.js';
import { hashKey, cacheInvalidate } from '../../services/ai/ai.cache.js';
import type { CandidateBrief } from '../../services/ai/ai.types.js';
import type { MatchResult } from '../../services/matching/matching.types.js';
import type { AuthUser } from '../../middleware/auth.middleware.js';
import { evaluatePair } from './match.scoring.js';
import { publishMatchUpdate } from './match.events.js';

// ── Input snapshot + hashing ─────────────────────────────

interface ExplanationInputs {
  internalScoringHash?: string;
  externalScoringHash?: string;
  matchScore: number;
  confidenceScore: number;
  matchType: string;
  riskLevel: string;
}

function hashInputs(inp: ExplanationInputs): string {
  const normalized = JSON.stringify(inp, Object.keys(inp).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Human-readable labels for each input — surfaced in the modal so the
// operator knows why the explanation refreshed ("מה השתנה").
const CHANGE_LABELS: Record<keyof ExplanationInputs, string> = {
  internalScoringHash: 'פרופיל המועמד הפנימי',
  externalScoringHash: 'פרופיל המועמד החיצוני',
  matchScore: 'ציון ההתאמה',
  confidenceScore: 'ציון הביטחון',
  matchType: 'סוג ההתאמה',
  riskLevel: 'רמת הסיכון',
};

function diffInputs(
  prev: Partial<ExplanationInputs> | undefined,
  next: ExplanationInputs,
): string[] {
  if (!prev) return [];
  const changed: string[] = [];
  for (const key of Object.keys(CHANGE_LABELS) as Array<keyof ExplanationInputs>) {
    if (prev[key] !== next[key]) changed.push(CHANGE_LABELS[key]);
  }
  return changed;
}

// ── Engine re-evaluation ─────────────────────────────────

// Compact signature of the engine output. If this differs between the
// stored suggestion and a fresh evaluation, the pair's score/analysis
// genuinely changed (maybe improved) and the suggestion must be updated.
function engineSignature(x: {
  matchScore: number;
  confidenceScore: number;
  matchType: string;
  riskLevel: string;
  scoreBreakdown?: Array<{ dimension: string; score: number }>;
}): string {
  return JSON.stringify({
    m: x.matchScore,
    c: x.confidenceScore,
    t: x.matchType,
    r: x.riskLevel,
    b: (x.scoreBreakdown ?? []).map((d) => [d.dimension, d.score]),
  });
}

// Copy the fresh engine result onto the suggestion IN PLACE — only the
// scoring/analysis fields. Status, eligibility, override flags and
// blockers are deliberately NOT touched here: lifecycle transitions
// belong to the scan / approve / decline paths, not an advisory refresh.
function applyEngineResult(suggestion: IMatchSuggestion, r: MatchResult): void {
  suggestion.matchScore = r.matchScore;
  suggestion.confidenceScore = r.confidenceScore;
  suggestion.matchType = r.matchType;
  suggestion.riskLevel = r.riskLevel;
  suggestion.scoreBreakdown = r.scoreBreakdown;
  suggestion.strengths = r.strengths;
  suggestion.attentionPoints = r.attentionPoints;
  suggestion.recommendedAction = r.recommendedAction;
  suggestion.sendStrategy = r.sendStrategy;
  suggestion.penalties = r.penalties;
  if (r.semanticSimilarityScore !== undefined) {
    suggestion.semanticSimilarityScore = r.semanticSimilarityScore;
  }
  suggestion.markModified('scoreBreakdown');
  suggestion.markModified('penalties');
}

// ── Candidate briefs (AI never sees raw DB docs) ─────────

function computeAge(dob?: Date): number | undefined {
  if (!dob) return undefined;
  const d = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? age : undefined;
}

function brief(d: Record<string, unknown>, age?: number): CandidateBrief {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    id: String(d['_id']),
    firstName: str(d['firstName']),
    lastName: str(d['lastName']),
    gender: str(d['gender']),
    age,
    city: str(d['city']),
    sectorGroup: str(d['sectorGroup']),
    subSector: str(d['subSector']),
    lifestyleTone: str(d['lifestyleTone']),
    personalStatus: str(d['personalStatus']),
    lifeStage: str(d['lifeStage']),
    studyWorkDirection: str(d['studyWorkDirection']),
    about: str(d['about']),
    whatSeeking: str(d['whatSeeking']),
  };
}

// ── DTO ──────────────────────────────────────────────────

export interface MatchExplanationDTO {
  summary: string;
  strengths: string[];
  concerns: string[];
  nuance: string;
  recommendedApproach: string;
  notMatchReasons: string[];
  generatedAt?: string;
  provider?: string;
  model?: string;
}

export interface ExplainMatchResult {
  explanation: MatchExplanationDTO;
  // true when served from the persisted explanation (no AI call made).
  fromCache: boolean;
  // Labels of inputs that changed since the last generation. Empty when
  // served from cache or first-generated.
  changedFields: string[];
  // true when the fresh engine re-evaluation differed from the stored
  // suggestion and the score/analysis fields were updated in place.
  rescored: boolean;
  // Engine score movement detected by the re-evaluation.
  score: {
    current: number;
    previous: number;
    delta: number;
    direction: 'up' | 'down' | 'same';
  };
}

type StoredExplanation = NonNullable<IMatchSuggestion['aiExplanation']>;

function toDTO(e: StoredExplanation): MatchExplanationDTO {
  return {
    summary: e.text ?? '',
    strengths: e.strengths ?? [],
    concerns: e.concerns ?? [],
    nuance: e.nuance ?? '',
    recommendedApproach: e.recommendedApproach ?? '',
    notMatchReasons: e.notMatchReasons ?? [],
    generatedAt: e.generatedAt ? new Date(e.generatedAt).toISOString() : undefined,
    provider: e.provider,
    model: e.model,
  };
}

// ── Public API ───────────────────────────────────────────

/**
 * Return the persisted AI explanation for a suggestion.
 *
 * Read-only by default: when neither candidate has been edited since the
 * explanation was generated, the stored answer is served with no engine
 * run, no AI call and no DB write. Candidate data only changes on a
 * manual edit, so a newer candidate `updatedAt` (or `force`) is what
 * triggers a re-check — then the deterministic engine re-evaluates the
 * pair; if the score/analysis actually moved the suggestion is updated
 * in place, and the AI explanation is regenerated when anything material
 * changed (or `force`). Lifecycle (status/eligibility) is never touched
 * here — that belongs to the scan / approve / decline paths.
 */
export async function explainMatchSuggestion(
  id: string,
  user: AuthUser,
  opts: { force?: boolean } = {},
): Promise<ExplainMatchResult> {
  const suggestion = await MatchSuggestion.findById(id).exec();
  if (!suggestion) throw new NotFoundError('MatchSuggestion', id);

  const [internal, external] = await Promise.all([
    InternalCandidate.findById(suggestion.internalCandidateId).lean().exec(),
    ExternalCandidate.findById(suggestion.externalCandidateId).lean().exec(),
  ]);
  if (!internal) throw new NotFoundError('InternalCandidate', String(suggestion.internalCandidateId));
  if (!external) throw new NotFoundError('ExternalCandidate', String(suggestion.externalCandidateId));

  const internalUpdatedAt = (internal as { updatedAt?: Date }).updatedAt;
  const externalUpdatedAt = (external as { updatedAt?: Date }).updatedAt;
  const existing = suggestion.aiExplanation;

  const sameStamp = (a?: Date, b?: Date) =>
    a != null && b != null && new Date(a).getTime() === new Date(b).getTime();

  // A candidate was edited (or we have no prior explanation) → re-check.
  const profileTouched =
    !existing?.text
    || !sameStamp(existing.sourceInternalUpdatedAt, internalUpdatedAt)
    || !sameStamp(existing.sourceExternalUpdatedAt, externalUpdatedAt);

  const stableScore = {
    current: suggestion.matchScore,
    previous: suggestion.matchScore,
    delta: 0,
    direction: 'same' as const,
  };

  // ── Read-only fast path ─────────────────────────────────
  // Nobody edited either side and no forced refresh → serve as-is.
  if (!profileTouched && !opts.force) {
    return {
      explanation: toDTO(existing!),
      fromCache: true,
      changedFields: [],
      rescored: false,
      score: stableScore,
    };
  }

  // ── Re-check path (manual edit detected, or forced) ─────
  const previousScore = suggestion.matchScore;
  const before = suggestion.toObject() as unknown as Record<string, unknown>;

  // Deterministic engine re-evaluation (no AI). Source of truth for
  // whether the match actually improved / declined.
  const fresh = await evaluatePair(
    String(suggestion.internalCandidateId),
    String(suggestion.externalCandidateId),
    suggestion.sourceMode,
  );
  const engineChanged = engineSignature(suggestion) !== engineSignature(fresh);
  if (engineChanged) applyEngineResult(suggestion, fresh);

  const currentScore = suggestion.matchScore;
  const delta = currentScore - previousScore;
  const scoreInfo = {
    current: currentScore,
    previous: previousScore,
    delta,
    direction: (delta > 0 ? 'up' : delta < 0 ? 'down' : 'same') as 'up' | 'down' | 'same',
  };

  const inputs: ExplanationInputs = {
    internalScoringHash: (internal as { scoringHash?: string }).scoringHash,
    externalScoringHash: (external as { scoringHash?: string }).scoringHash,
    matchScore: suggestion.matchScore,
    confidenceScore: suggestion.confidenceScore,
    matchType: suggestion.matchType,
    riskLevel: suggestion.riskLevel,
  };
  const inputHash = hashInputs(inputs);

  const staleExplanation = !existing?.text || existing.inputHash !== inputHash;
  const needAI = engineChanged || staleExplanation || Boolean(opts.force);

  // Edit that didn't move anything material (e.g. a typo fix, or the scan
  // already applied the change). Just refresh the source stamps so we
  // don't re-check on every future open, and serve the stored answer.
  if (!needAI) {
    suggestion.aiExplanation!.sourceInternalUpdatedAt = internalUpdatedAt;
    suggestion.aiExplanation!.sourceExternalUpdatedAt = externalUpdatedAt;
    suggestion.markModified('aiExplanation');
    await suggestion.save();
    return {
      explanation: toDTO(existing!),
      fromCache: true,
      changedFields: [],
      rescored: false,
      score: scoreInfo,
    };
  }

  // The AI service keeps its own short-lived in-memory cache keyed only
  // by pair IDs + scores; bust it so a profile-only change (same scores)
  // or a forced refresh yields a genuinely fresh answer.
  cacheInvalidate(hashKey('explainMatch', {
    internalId: brief(internal as Record<string, unknown>).id,
    externalId: brief(external as Record<string, unknown>).id,
    matchScore: suggestion.matchScore,
    confidenceScore: suggestion.confidenceScore,
    matchType: suggestion.matchType,
  }));

  const ai = await explainMatch(
    {
      internal: brief(internal as Record<string, unknown>, computeAge((internal as { dateOfBirth?: Date }).dateOfBirth)),
      external: brief(external as Record<string, unknown>, (external as { age?: number }).age),
      matchScore: suggestion.matchScore,
      confidenceScore: suggestion.confidenceScore,
      matchType: suggestion.matchType,
      riskLevel: suggestion.riskLevel,
      strengths: suggestion.strengths ?? [],
      attentionPoints: suggestion.attentionPoints ?? [],
      scoreBreakdown: (suggestion.scoreBreakdown ?? []).map((s) => ({
        dimension: s.dimension,
        score: s.score,
        detail: s.detail ?? '',
      })),
    },
    { userId: user.id, suggestionId: String(suggestion._id) },
  );

  const changedFields = diffInputs(existing?.inputs, inputs);
  const meta = ai.metadata as { provider?: string; model?: string };

  suggestion.aiExplanation = {
    text: ai.data.summary,
    strengths: ai.data.strengths,
    concerns: ai.data.concerns,
    nuance: ai.data.nuance,
    recommendedApproach: ai.data.recommendedApproach,
    notMatchReasons: ai.data.notMatchReasons,
    generatedAt: new Date(),
    provider: meta.provider,
    model: meta.model,
    inputHash,
    previousInputHash: existing?.inputHash,
    inputs,
    changedFields,
    sourceInternalUpdatedAt: internalUpdatedAt,
    sourceExternalUpdatedAt: externalUpdatedAt,
  };
  await suggestion.save();
  if (engineChanged) {
    await auditRescore(before, suggestion, user.id, scoreInfo);
    publishMatchUpdate(suggestion, 'updated');
  }

  return {
    explanation: toDTO(suggestion.aiExplanation),
    fromCache: false,
    changedFields,
    rescored: engineChanged,
    score: scoreInfo,
  };
}

// Audit an on-demand engine re-score triggered by the explain flow.
async function auditRescore(
  before: Record<string, unknown>,
  suggestion: IMatchSuggestion,
  performedBy: string,
  score: { previous: number; current: number; delta: number; direction: string },
): Promise<void> {
  await audit({
    entityType: AuditEntityType.MATCH_SUGGESTION,
    entityId: String(suggestion._id),
    actionType: AuditActionType.UPDATE,
    performedBy,
    before,
    after: suggestion.toObject(),
    metadata: {
      source: 'explain_rescore',
      previousScore: score.previous,
      newScore: score.current,
      delta: score.delta,
      direction: score.direction,
    },
  });
}
