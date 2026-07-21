// ═══════════════════════════════════════════════════════════
// ShadchanAI — AI Tools Layer
//
// This is the ONLY interface the AI service uses to access
// business data. Every function here is READ-ONLY — no writes,
// no state mutations, no side effects on business entities.
//
// These tools wrap Mongoose queries with sane defaults:
//   - respect status / availability
//   - exclude archived
//   - apply reasonable result caps
//   - return compact, AI-safe shapes (no raw Documents)
//
// If the AI needs to do something here can't, add a new tool.
// Never let the AI call models directly.
// ═══════════════════════════════════════════════════════════

import {
  InternalCandidate,
  ExternalCandidate,
  MatchSuggestion,
} from '../../models/index.js';
import type {
  MatchableInternal,
  MatchableExternal,
  MatchingContext,
} from '../matching/matching.types.js';
import { findMatches } from '../matching/matching.engine.js';
import { PAGINATION } from '../../config/constants.js';

// ── Tool result shapes (AI-safe, compact) ────────────────

export interface ToolCandidateBrief {
  id: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  subSector?: string;
  lifestyleTone?: string;
  personalStatus?: string;
  lifeStage?: string;
  studyWorkDirection?: string;
  status?: string;
  profileCompletion?: number;
  lastVerifiedAt?: Date;
  lastActionAt?: Date;
  deferredSuggestionsCount?: number;
  /** Items that prevent sending this candidate */
  sendReadinessBlockers?: string[];
  /** Missing critical fields */
  missingCriticalFields?: string[];
}

export interface ToolExternalCandidateBrief extends ToolCandidateBrief {
  source?: string;
  availabilityStatus?: string;
  staleAt?: Date;
  lastSourceUpdateAt?: Date;
}

export interface ToolMatchBrief {
  id: string;
  internalCandidateId: string;
  externalCandidateId: string;
  matchScore: number;
  confidenceScore: number;
  matchType: string;
  riskLevel: string;
  status: string;
  strengths: string[];
  attentionPoints: string[];
  recommendedAction: string;
  createdAt: Date;
}

// ── Tool: getMatchingCandidatesTool ──────────────────────
// Find new match candidates for a given internal candidate using
// the deterministic engine. Returns engine results — NOT stored.

export interface GetMatchingCandidatesArgs {
  internalCandidateId: string;
  mode?: 'strict' | 'discovery';
  limit?: number;
  externalFilter?: {
    sectorGroup?: string;
    subSector?: string;
    city?: string;
    ageMin?: number;
    ageMax?: number;
  };
}

/**
 * Engine result enriched with the external candidate's identity and
 * flattened to an AI-safe row: the summary prompt previews these
 * verbatim (raw MatchResult with scoreBreakdown/blockers would bloat
 * it), and the Ask-AI panel renders them as a person-facing table.
 */
export interface MatchingCandidateRow {
  externalCandidateId: string;
  firstName?: string;
  lastName?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  personalStatus?: string;
  eligible: boolean;
  matchScore: number;
  confidenceScore: number;
  matchType: string;
  riskLevel: string;
  strengths: string[];
  attentionPoints: string[];
}

export async function getMatchingCandidatesTool(
  args: GetMatchingCandidatesArgs,
): Promise<{ results: MatchingCandidateRow[]; internalFound: boolean }> {
  const internal = await InternalCandidate.findById(args.internalCandidateId).lean();
  if (!internal) return { results: [], internalFound: false };

  // Build external-candidate query
  const externalQuery: Record<string, unknown> = {
    status: 'active',
    availabilityStatus: { $ne: 'unavailable' },
    gender: internal.gender === 'male' ? 'female' : 'male',
  };
  if (args.externalFilter?.sectorGroup) externalQuery['sectorGroup'] = args.externalFilter.sectorGroup;
  if (args.externalFilter?.subSector) externalQuery['subSector'] = args.externalFilter.subSector;
  if (args.externalFilter?.city) externalQuery['city'] = args.externalFilter.city;
  if (args.externalFilter?.ageMin !== undefined || args.externalFilter?.ageMax !== undefined) {
    const ageQ: Record<string, number> = {};
    if (args.externalFilter.ageMin !== undefined) ageQ['$gte'] = args.externalFilter.ageMin;
    if (args.externalFilter.ageMax !== undefined) ageQ['$lte'] = args.externalFilter.ageMax;
    externalQuery['age'] = ageQ;
  }

  const externals = await ExternalCandidate.find(externalQuery)
    .limit(500) // pre-filter cap before engine
    .lean();

  // Build context: active matches + recent declines
  const activeSuggestions = await MatchSuggestion.find({
    internalCandidateId: args.internalCandidateId,
    status: { $nin: ['closed', 'expired'] },
  }).select('externalCandidateId status createdAt').lean();

  const activeMatchExternalIds = new Set<string>(
    activeSuggestions.map((s) => String(s.externalCandidateId)),
  );

  const declines = await MatchSuggestion.find({
    internalCandidateId: args.internalCandidateId,
    status: { $in: ['declined_side_a', 'declined_side_b'] },
    closedAt: { $gte: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) },
  }).select('externalCandidateId closedAt').lean();

  const recentDeclines = new Map<string, Date>();
  for (const d of declines) {
    if (d.closedAt) recentDeclines.set(String(d.externalCandidateId), d.closedAt);
  }

  const context: MatchingContext = {
    mode: args.mode ?? 'strict',
    activeMatchExternalIds,
    recentDeclines,
    activeSuggestionCount: activeSuggestions.length,
  };

  const results = findMatches(
    toMatchableInternal(internal),
    externals.map(toMatchableExternal),
    context,
  );

  const limit = Math.min(args.limit ?? PAGINATION.DEFAULT_LIMIT, 50);
  const top = results.slice(0, limit);

  // Attach the external identity so rows render as people, not ids.
  // `externals` is already in memory — index it instead of re-querying.
  const externalById = new Map(externals.map((e) => [String(e._id), e]));
  const rows: MatchingCandidateRow[] = top.map((r) => {
    const ext = externalById.get(String(r.externalCandidateId));
    return {
      externalCandidateId: String(r.externalCandidateId),
      firstName: ext?.firstName,
      lastName: ext?.lastName,
      age: ext?.age,
      city: ext?.city,
      sectorGroup: ext?.sectorGroup,
      personalStatus: ext?.personalStatus,
      eligible: r.eligible,
      matchScore: r.matchScore,
      confidenceScore: r.confidenceScore,
      matchType: r.matchType,
      riskLevel: r.riskLevel,
      strengths: r.strengths.slice(0, 4),
      attentionPoints: r.attentionPoints.slice(0, 4),
    };
  });

  return { results: rows, internalFound: true };
}

// ── Tool: getUnhandledCandidatesTool ─────────────────────
// Internal candidates with no recent action / suggestions.

export interface GetUnhandledCandidatesArgs {
  daysSinceAction?: number;
  limit?: number;
}

export async function getUnhandledCandidatesTool(
  args: GetUnhandledCandidatesArgs,
): Promise<ToolCandidateBrief[]> {
  const days = args.daysSinceAction ?? 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const limit = Math.min(args.limit ?? PAGINATION.DEFAULT_LIMIT, 50);

  const docs = await InternalCandidate.find({
    status: 'active',
    archivedAt: { $exists: false },
    $or: [
      { lastActionAt: { $lt: cutoff } },
      { lastActionAt: { $exists: false } },
    ],
  })
    .sort({ lastActionAt: 1 })
    .limit(limit)
    .lean();

  return docs.map(toCandidateBrief);
}

// ── Tool: getHighScoreMatchesTool ────────────────────────
// Existing match suggestions with high scores, filterable.

export interface GetHighScoreMatchesArgs {
  minScore?: number;
  matchType?: string;
  status?: string;
  limit?: number;
}

export async function getHighScoreMatchesTool(
  args: GetHighScoreMatchesArgs,
): Promise<ToolMatchBrief[]> {
  const query: Record<string, unknown> = {
    matchScore: { $gte: args.minScore ?? 75 },
    eligible: true,
  };
  if (args.matchType) query['matchType'] = args.matchType;
  if (args.status) query['status'] = args.status;

  const limit = Math.min(args.limit ?? PAGINATION.DEFAULT_LIMIT, 50);

  const docs = await MatchSuggestion.find(query)
    .sort({ matchScore: -1, confidenceScore: -1 })
    .limit(limit)
    .lean();

  return docs.map(toMatchBrief);
}

// ── Tool: getSimilarCandidatesTool ───────────────────────
// Candidates similar to a given one. Uses embeddings if available,
// otherwise falls back to attribute-based similarity.

export interface GetSimilarCandidatesArgs {
  candidateId: string;
  /** Look in internal or external collection */
  scope?: 'internal' | 'external';
  limit?: number;
}

export async function getSimilarCandidatesTool(
  args: GetSimilarCandidatesArgs,
): Promise<ToolCandidateBrief[]> {
  const limit = Math.min(args.limit ?? 10, 30);
  const scope = args.scope ?? 'external';

  const sourceDoc = scope === 'internal'
    ? await InternalCandidate.findById(args.candidateId).lean()
    : await ExternalCandidate.findById(args.candidateId).lean();

  if (!sourceDoc) return [];

  // Attribute-based similarity (primary path — works without embeddings).
  // Match on sector group + life stage + similar age.
  // Branch on scope so each Mongoose query keeps its model-specific types.
  const source = sourceDoc; // narrow the reference for closures below
  const baseQuery: Record<string, unknown> = {
    _id: { $ne: source._id },
    sectorGroup: source.sectorGroup,
  };
  if (source.lifeStage) baseQuery['lifeStage'] = source.lifeStage;

  type AnyDoc = {
    subSector?: string;
    lifestyleTone?: string;
    city?: string;
    studyWorkDirection?: string;
    personalStatus?: string;
  };

  const scoreDoc = (doc: AnyDoc): number => {
    let score = 0;
    if (doc.subSector === source.subSector) score += 3;
    if (doc.lifestyleTone === source.lifestyleTone) score += 2;
    if (doc.city === source.city) score += 2;
    if (doc.studyWorkDirection === source.studyWorkDirection) score += 1;
    if (doc.personalStatus === source.personalStatus) score += 1;
    return score;
  };

  if (scope === 'internal') {
    const docs = await InternalCandidate.find(baseQuery).limit(limit * 2).lean();
    const ranked = docs
      .map((doc) => ({ doc, score: scoreDoc(doc as AnyDoc) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return ranked.map((r) => toCandidateBrief(r.doc));
  } else {
    const docs = await ExternalCandidate.find(baseQuery).limit(limit * 2).lean();
    const ranked = docs
      .map((doc) => ({ doc, score: scoreDoc(doc as AnyDoc) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return ranked.map((r) => toExternalCandidateBrief(r.doc));
  }
}

// ── Tool: getStaleCandidatesTool ─────────────────────────
// External candidates that have become stale.

export interface GetStaleCandidatesArgs {
  daysSinceUpdate?: number;
  limit?: number;
}

export async function getStaleCandidatesTool(
  args: GetStaleCandidatesArgs,
): Promise<ToolExternalCandidateBrief[]> {
  const days = args.daysSinceUpdate ?? 60;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const limit = Math.min(args.limit ?? PAGINATION.DEFAULT_LIMIT, 50);

  const docs = await ExternalCandidate.find({
    status: 'active',
    $or: [
      { staleAt: { $exists: true, $ne: null } },
      { lastSourceUpdateAt: { $lt: cutoff } },
      { lastSourceUpdateAt: { $exists: false }, sourceImportedAt: { $lt: cutoff } },
    ],
  })
    .sort({ lastSourceUpdateAt: 1 })
    .limit(limit)
    .lean();

  return docs.map(toExternalCandidateBrief);
}

// ── Tool: getCandidatesNeedingAttentionTool ──────────────
// Candidates with send-readiness blockers, low completion,
// overdue verification, or other flags requiring review.

export interface GetCandidatesNeedingAttentionArgs {
  limit?: number;
  reasonFilter?: 'blockers' | 'low_completion' | 'unverified' | 'any';
}

export async function getCandidatesNeedingAttentionTool(
  args: GetCandidatesNeedingAttentionArgs,
): Promise<Array<ToolCandidateBrief & { attentionReasons: string[] }>> {
  const limit = Math.min(args.limit ?? PAGINATION.DEFAULT_LIMIT, 50);
  const reason = args.reasonFilter ?? 'any';

  const conditions: Record<string, unknown>[] = [];
  if (reason === 'blockers' || reason === 'any') {
    conditions.push({ sendReadinessBlockers: { $exists: true, $ne: [] } });
  }
  if (reason === 'low_completion' || reason === 'any') {
    conditions.push({ profileCompletion: { $lt: 60 } });
  }
  if (reason === 'unverified' || reason === 'any') {
    const unverifiedCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    conditions.push({
      $or: [
        { lastVerifiedAt: { $exists: false } },
        { lastVerifiedAt: { $lt: unverifiedCutoff } },
      ],
    });
  }

  const query: Record<string, unknown> = {
    status: 'active',
    archivedAt: { $exists: false },
    $or: conditions,
  };

  const docs = await InternalCandidate.find(query)
    .limit(limit)
    .lean();

  return docs.map((doc) => {
    const reasons: string[] = [];
    if (doc.sendReadinessBlockers && doc.sendReadinessBlockers.length > 0) {
      reasons.push(`${doc.sendReadinessBlockers.length} send-readiness blocker(s)`);
    }
    if ((doc.profileCompletion ?? 100) < 60) {
      reasons.push(`Profile only ${doc.profileCompletion ?? 0}% complete`);
    }
    if (!doc.lastVerifiedAt || doc.lastVerifiedAt < new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)) {
      reasons.push('Not verified in the last 90 days');
    }
    return { ...toCandidateBrief(doc), attentionReasons: reasons };
  });
}

// ── Tool: summarizeCandidateTool ─────────────────────────
// Fetch a compact candidate profile suitable for the
// summarizeCandidate AI method. Returns null if not found.
// This is a FETCH tool — actual summarization is done by ai.service.

export interface SummarizeCandidateArgs {
  candidateId: string;
  scope?: 'internal' | 'external';
}

export async function summarizeCandidateTool(
  args: SummarizeCandidateArgs,
): Promise<ToolCandidateBrief | null> {
  const scope = args.scope ?? 'internal';
  const doc = scope === 'internal'
    ? await InternalCandidate.findById(args.candidateId).lean()
    : await ExternalCandidate.findById(args.candidateId).lean();

  if (!doc) return null;

  return scope === 'internal'
    ? toCandidateBrief(doc)
    : toExternalCandidateBrief(doc);
}

// ═══════════════════════════════════════════════════════════
// Internal conversion helpers (DB → AI-safe)
// ═══════════════════════════════════════════════════════════

function toCandidateBrief(doc: {
  _id: unknown;
  firstName?: string;
  lastName?: string;
  gender?: string;
  dateOfBirth?: Date;
  city?: string;
  sectorGroup?: string;
  subSector?: string;
  lifestyleTone?: string;
  personalStatus?: string;
  lifeStage?: string;
  studyWorkDirection?: string;
  status?: string;
  profileCompletion?: number;
  missingCriticalFields?: string[];
  sendReadinessBlockers?: string[];
  lastVerifiedAt?: Date;
  lastActionAt?: Date;
  deferredSuggestionsCount?: number;
}): ToolCandidateBrief {
  return {
    id: String(doc._id),
    firstName: doc.firstName,
    lastName: doc.lastName,
    gender: doc.gender,
    age: doc.dateOfBirth ? ageFromDob(doc.dateOfBirth) : undefined,
    city: doc.city,
    sectorGroup: doc.sectorGroup,
    subSector: doc.subSector,
    lifestyleTone: doc.lifestyleTone,
    personalStatus: doc.personalStatus,
    lifeStage: doc.lifeStage,
    studyWorkDirection: doc.studyWorkDirection,
    status: doc.status,
    profileCompletion: doc.profileCompletion,
    missingCriticalFields: doc.missingCriticalFields,
    sendReadinessBlockers: doc.sendReadinessBlockers,
    lastVerifiedAt: doc.lastVerifiedAt,
    lastActionAt: doc.lastActionAt,
    deferredSuggestionsCount: doc.deferredSuggestionsCount,
  };
}

function toExternalCandidateBrief(doc: {
  _id: unknown;
  firstName?: string;
  lastName?: string;
  gender?: string;
  age?: number;
  city?: string;
  sectorGroup?: string;
  subSector?: string;
  lifestyleTone?: string;
  personalStatus?: string;
  lifeStage?: string;
  studyWorkDirection?: string;
  status?: string;
  sourceType?: string;
  availabilityStatus?: string;
  staleAt?: Date;
  lastSourceUpdateAt?: Date;
}): ToolExternalCandidateBrief {
  return {
    id: String(doc._id),
    firstName: doc.firstName,
    lastName: doc.lastName,
    gender: doc.gender,
    age: doc.age,
    city: doc.city,
    sectorGroup: doc.sectorGroup,
    subSector: doc.subSector,
    lifestyleTone: doc.lifestyleTone,
    personalStatus: doc.personalStatus,
    lifeStage: doc.lifeStage,
    studyWorkDirection: doc.studyWorkDirection,
    status: doc.status,
    source: doc.sourceType,
    availabilityStatus: doc.availabilityStatus,
    staleAt: doc.staleAt,
    lastSourceUpdateAt: doc.lastSourceUpdateAt,
  };
}

function toMatchBrief(doc: {
  _id: unknown;
  internalCandidateId: unknown;
  externalCandidateId: unknown;
  matchScore: number;
  confidenceScore: number;
  matchType: string;
  riskLevel: string;
  status: string;
  strengths?: string[];
  attentionPoints?: string[];
  recommendedAction?: string;
  createdAt?: Date;
}): ToolMatchBrief {
  return {
    id: String(doc._id),
    internalCandidateId: String(doc.internalCandidateId),
    externalCandidateId: String(doc.externalCandidateId),
    matchScore: doc.matchScore,
    confidenceScore: doc.confidenceScore,
    matchType: doc.matchType,
    riskLevel: doc.riskLevel,
    status: doc.status,
    strengths: doc.strengths ?? [],
    attentionPoints: doc.attentionPoints ?? [],
    recommendedAction: doc.recommendedAction ?? '',
    createdAt: doc.createdAt ?? new Date(0),
  };
}

function toMatchableInternal(doc: Record<string, unknown>): MatchableInternal {
  return {
    _id: String(doc['_id']),
    firstName: (doc['firstName'] as string) ?? '',
    lastName: (doc['lastName'] as string) ?? '',
    gender: doc['gender'] as MatchableInternal['gender'],
    dateOfBirth: doc['dateOfBirth'] as Date,
    city: doc['city'] as string | undefined,
    height: doc['height'] as number | undefined,
    sectorGroup: doc['sectorGroup'] as MatchableInternal['sectorGroup'],
    subSector: doc['subSector'] as MatchableInternal['subSector'],
    lifestyleTone: doc['lifestyleTone'] as MatchableInternal['lifestyleTone'],
    religiousStyle: doc['religiousStyle'] as MatchableInternal['religiousStyle'],
    personalStatus: (doc['personalStatus'] as MatchableInternal['personalStatus']) ?? 'single',
    numberOfChildren: (doc['numberOfChildren'] as number) ?? 0,
    lifeStage: doc['lifeStage'] as MatchableInternal['lifeStage'],
    readinessForMarriage: (doc['readinessForMarriage'] as MatchableInternal['readinessForMarriage']) ?? 'open',
    studyWorkDirection: doc['studyWorkDirection'] as MatchableInternal['studyWorkDirection'],
    hardConstraints: (doc['hardConstraints'] as MatchableInternal['hardConstraints']) ?? [],
    softPreferences: (doc['softPreferences'] as MatchableInternal['softPreferences']) ?? [],
    agePreferences: doc['agePreferences'] as MatchableInternal['agePreferences'],
    locationPreferences: doc['locationPreferences'] as MatchableInternal['locationPreferences'],
    // openToDivorced omitted (tri-state): missing openness = unknown, not "not open".
    openness: (doc['openness'] as MatchableInternal['openness']) ?? {
      openToOtherSectors: false,
      openToConverts: false,
      openToWithChildren: false,
      openToAgeDifference: false,
      openToLongDistance: false,
    },
    profileCompletion: (doc['profileCompletion'] as number) ?? 0,
    missingCriticalFields: (doc['missingCriticalFields'] as string[]) ?? [],
    sendReadinessBlockers: (doc['sendReadinessBlockers'] as string[]) ?? [],
    profileQualityScore: doc['profileQualityScore'] as number | undefined,
    dataReliabilityScore: doc['dataReliabilityScore'] as number | undefined,
    readinessScore: doc['readinessScore'] as number | undefined,
    status: (doc['status'] as MatchableInternal['status']) ?? 'active',
    lastVerifiedAt: doc['lastVerifiedAt'] as Date | undefined,
    lastActionAt: doc['lastActionAt'] as Date | undefined,
    datingPartnerCandidateId: doc['datingPartnerCandidateId']
      ? String(doc['datingPartnerCandidateId'])
      : undefined,
    deferredSuggestionsCount: (doc['deferredSuggestionsCount'] as number) ?? 0,
  };
}

function toMatchableExternal(doc: Record<string, unknown>): MatchableExternal {
  return {
    _id: String(doc['_id']),
    firstName: doc['firstName'] as string | undefined,
    lastName: doc['lastName'] as string | undefined,
    gender: doc['gender'] as MatchableExternal['gender'],
    age: doc['age'] as number | undefined,
    city: doc['city'] as string | undefined,
    height: doc['height'] as number | undefined,
    sectorGroup: doc['sectorGroup'] as MatchableExternal['sectorGroup'],
    subSector: doc['subSector'] as MatchableExternal['subSector'],
    lifestyleTone: doc['lifestyleTone'] as MatchableExternal['lifestyleTone'],
    personalStatus: doc['personalStatus'] as MatchableExternal['personalStatus'],
    lifeStage: doc['lifeStage'] as MatchableExternal['lifeStage'],
    studyWorkDirection: doc['studyWorkDirection'] as MatchableExternal['studyWorkDirection'],
    availabilityStatus: (doc['availabilityStatus'] as MatchableExternal['availabilityStatus']) ?? 'unknown',
    status: (doc['status'] as MatchableExternal['status']) ?? 'active',
    shareCard: (doc['shareCard'] as MatchableExternal['shareCard']) ?? { approvedForShare: false },
    ageReliability: doc['ageReliability'] as MatchableExternal['ageReliability'],
    hardConstraints: doc['hardConstraints'] as MatchableExternal['hardConstraints'],
    softPreferences: doc['softPreferences'] as MatchableExternal['softPreferences'],
    agePreferences: doc['agePreferences'] as MatchableExternal['agePreferences'],
    locationPreferences: doc['locationPreferences'] as MatchableExternal['locationPreferences'],
    openness: doc['openness'] as MatchableExternal['openness'],
    staleAt: doc['staleAt'] as Date | undefined,
    lastConfirmedAvailableAt: doc['lastConfirmedAvailableAt'] as Date | undefined,
    lastSourceUpdateAt: doc['lastSourceUpdateAt'] as Date | undefined,
    sourceImportedAt: (doc['sourceImportedAt'] as Date) ?? new Date(0),
  };
}

function ageFromDob(dob: Date): number {
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}
