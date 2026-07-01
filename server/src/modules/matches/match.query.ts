// ═══════════════════════════════════════════════════════════
// ShadchanAI — Match read queries (no mutations)
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import {
  MatchSuggestion,
  InternalCandidate,
  ExternalCandidate,
  type IMatchSuggestion,
} from '../../models/index.js';
import { NotFoundError } from '../../utils/errors.js';
import { toSkipLimit, buildSort, makeMeta } from '../../utils/pagination.js';
import { applyOwnershipFilter } from '../../utils/ownership.js';
import type { ListMatchesQuery } from './match.validator.js';

// Match list rows carry resolved candidate names so cards render people,
// not raw ids. Lightweight projection — names only.
export type MatchListItem = IMatchSuggestion & { internalName: string; externalName: string };

export async function listMatches(
  query: ListMatchesQuery,
  currentUserId?: string,
): Promise<{ items: MatchListItem[]; total: number; meta: ReturnType<typeof makeMeta> }> {
  const { skip, limit } = toSkipLimit(query);
  const sort = buildSort(query, 'matchScore');

  const filter: Record<string, unknown> = {};
  if (query.status) filter['status'] = query.status;
  if (query.matchType) filter['matchType'] = query.matchType;
  if (query.internalCandidateId) filter['internalCandidateId'] = new Types.ObjectId(query.internalCandidateId);
  if (query.externalCandidateId) filter['externalCandidateId'] = new Types.ObjectId(query.externalCandidateId);
  if (query.isDeferred !== undefined) filter['isDeferred'] = query.isDeferred;
  if (query.minScore !== undefined) filter['matchScore'] = { $gte: query.minScore };
  applyOwnershipFilter(filter, 'ownerUserId', query.ownership, currentUserId);

  const [items, total] = await Promise.all([
    MatchSuggestion.find(filter).sort(sort).skip(skip).limit(limit).lean().exec(),
    MatchSuggestion.countDocuments(filter).exec(),
  ]);

  const named = await attachCandidateNames(items as unknown as IMatchSuggestion[]);

  return {
    items: named,
    total,
    meta: makeMeta(query.page, query.limit, total),
  };
}

async function attachCandidateNames(items: IMatchSuggestion[]): Promise<MatchListItem[]> {
  const internalIds = [...new Set(items.map((m) => String(m.internalCandidateId)))];
  const externalIds = [...new Set(items.map((m) => String(m.externalCandidateId)))];
  const [internals, externals] = await Promise.all([
    InternalCandidate.find({ _id: { $in: internalIds } }).select('firstName lastName').lean().exec(),
    ExternalCandidate.find({ _id: { $in: externalIds } }).select('firstName lastName').lean().exec(),
  ]);
  const nameOf = (c: { firstName?: string; lastName?: string }) =>
    `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'ללא שם';
  const internalNames = new Map(internals.map((c) => [String(c._id), nameOf(c)]));
  const externalNames = new Map(externals.map((c) => [String(c._id), nameOf(c)]));
  return items.map((m) => ({
    ...m,
    internalName: internalNames.get(String(m.internalCandidateId)) ?? 'ללא שם',
    externalName: externalNames.get(String(m.externalCandidateId)) ?? 'ללא שם',
  })) as unknown as MatchListItem[];
}

export async function getMatchById(id: string): Promise<IMatchSuggestion> {
  const doc = await MatchSuggestion.findById(id).exec();
  if (!doc) throw new NotFoundError('MatchSuggestion', id);
  return doc;
}

// ── Explanation payload (engine data for AI/UI display) ──

export async function getExplanationPayload(id: string): Promise<{
  matchScore: number;
  confidenceScore: number;
  matchType: string;
  riskLevel: string;
  scoreBreakdown: unknown[];
  strengths: string[];
  attentionPoints: string[];
  overrideReasons: string[];
  recommendedAction: string;
  aiExplanation?: unknown;
}> {
  const doc = await getMatchById(id);
  return {
    matchScore: doc.matchScore,
    confidenceScore: doc.confidenceScore,
    matchType: doc.matchType,
    riskLevel: doc.riskLevel,
    scoreBreakdown: doc.scoreBreakdown,
    strengths: doc.strengths,
    attentionPoints: doc.attentionPoints,
    overrideReasons: doc.overrideReasons,
    recommendedAction: doc.recommendedAction,
    aiExplanation: doc.aiExplanation,
  };
}
