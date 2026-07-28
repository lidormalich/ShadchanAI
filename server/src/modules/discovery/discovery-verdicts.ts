// ═══════════════════════════════════════════════════════════
// Candidate-verdict lookup — shared decoration source for every
// operator-facing suggestion list (compatibility board, semantic
// ranking). Maps externalCandidateId → the candidate's OWN swipe
// verdict from "היכרות חכמה" sessions, newest verdict winning.
// Advisory only — never feeds scoring.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { DiscoverySession } from './discovery-session.model.js';

export interface CandidateVerdictInfo {
  verdict: 'like' | 'reject' | 'skip';
  reasons: string[];
  at?: string | undefined;
}

export async function loadCandidateVerdictMap(
  internalId: string,
): Promise<Map<string, CandidateVerdictInfo>> {
  const maps = await loadCandidateVerdictMaps([internalId]);
  return maps.get(internalId) ?? new Map();
}

/**
 * Batch variant for cross-internal lists (scan inbox, suggestion
 * lists): one query for all internals, returns
 * internalId → externalId → verdict.
 */
export async function loadCandidateVerdictMaps(
  internalIds: string[],
): Promise<Map<string, Map<string, CandidateVerdictInfo>>> {
  const out = new Map<string, Map<string, CandidateVerdictInfo>>();
  const ids = [...new Set(internalIds)].filter((id) => Types.ObjectId.isValid(id));
  if (ids.length === 0) return out;

  const sessions = await DiscoverySession.find({
    internalCandidateId: { $in: ids.map((id) => new Types.ObjectId(id)) },
    'cards.verdict': { $exists: true },
  })
    // Ascending → later sessions overwrite older verdicts in the map.
    .sort({ createdAt: 1 })
    .select('internalCandidateId cards.externalCandidateId cards.verdict cards.reasonChips cards.reasonText cards.verdictAt')
    .lean()
    .exec();

  for (const s of sessions) {
    const internalId = String(s.internalCandidateId);
    let inner = out.get(internalId);
    if (!inner) { inner = new Map(); out.set(internalId, inner); }
    for (const c of s.cards) {
      if (!c.verdict) continue;
      inner.set(String(c.externalCandidateId), {
        verdict: c.verdict,
        reasons: [...(c.reasonChips ?? []), ...(c.reasonText ? [c.reasonText] : [])],
        at: c.verdictAt ? new Date(c.verdictAt).toISOString() : undefined,
      });
    }
  }
  return out;
}

/** Single-pair convenience (match detail, pair check, evaluate preview). */
export async function getCandidateVerdictForPair(
  internalId: string,
  externalId: string,
): Promise<CandidateVerdictInfo | undefined> {
  const map = await loadCandidateVerdictMap(internalId);
  return map.get(externalId);
}

/**
 * Reverse direction (one EXTERNAL × many internals — the external
 * candidate page's "ניתוח התאמה"): internalId → verdict on this external.
 */
export async function loadVerdictsForExternal(
  externalId: string,
): Promise<Map<string, CandidateVerdictInfo>> {
  const out = new Map<string, CandidateVerdictInfo>();
  if (!Types.ObjectId.isValid(externalId)) return out;

  const sessions = await DiscoverySession.find({
    'cards.externalCandidateId': new Types.ObjectId(externalId),
  })
    .sort({ createdAt: 1 })
    .select('internalCandidateId cards.externalCandidateId cards.verdict cards.reasonChips cards.reasonText cards.verdictAt')
    .lean()
    .exec();

  for (const s of sessions) {
    for (const c of s.cards) {
      if (!c.verdict || String(c.externalCandidateId) !== externalId) continue;
      out.set(String(s.internalCandidateId), {
        verdict: c.verdict,
        reasons: [...(c.reasonChips ?? []), ...(c.reasonText ? [c.reasonText] : [])],
        at: c.verdictAt ? new Date(c.verdictAt).toISOString() : undefined,
      });
    }
  }
  return out;
}
