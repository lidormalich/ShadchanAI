// ═══════════════════════════════════════════════════════════
// Discovery learning fold — persists what a swipe session taught us
// into the operator-facing learning loop.
//
//   1. Candidate-stated rejection reasons → the RejectionReason bank
//      (category 'candidate_discovery', source 'candidate').
//   2. rebuildCandidateInsight — the learning corpus now includes
//      discovery sessions (see candidate-learning.service), so the
//      insight the operator sees (and explainMatch injects) absorbs
//      the candidate's own swipes.
//
// Deliberately NOT here: auto-writing softPreferences/whatSeeking onto
// the candidate profile. The operator reviews the session panel and
// decides — revealed preferences are signals, not facts.
//
// Idempotent via learningFoldedAt. Called from the public /finish
// handler and from the hourly expiry job for abandoned sessions.
// ═══════════════════════════════════════════════════════════

import { DiscoverySession } from './discovery-session.model.js';
import { ingestReasons, type IngestReasonInput } from '../rejection-reasons/rejection-reason.service.js';
import { rebuildCandidateInsight } from '../../services/ai/candidate-learning.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('discovery.learning');

export const DISCOVERY_REASON_CATEGORY = 'candidate_discovery';

// Abandoned sessions need at least this many verdicts to be worth folding.
export const MIN_VERDICTS_TO_FOLD = 3;

export async function foldSessionIntoLearning(sessionId: string): Promise<{
  folded: boolean;
  reasonsIngested: number;
  insightRebuilt: boolean;
}> {
  // Atomic idempotency claim — two concurrent folds (finish + job race)
  // can't both pass this gate.
  const session = await DiscoverySession.findOneAndUpdate(
    { _id: sessionId, learningFoldedAt: { $exists: false } },
    { $set: { learningFoldedAt: new Date() } },
    { new: true },
  ).exec();
  if (!session) return { folded: false, reasonsIngested: 0, insightRebuilt: false };

  // 1. Candidate-stated rejection reasons → the bank.
  const inputs: IngestReasonInput[] = [];
  for (const card of session.cards) {
    if (card.verdict !== 'reject') continue;
    const texts = [
      ...(card.reasonChips ?? []),
      ...(card.reasonText ? [card.reasonText] : []),
    ];
    for (const text of texts) {
      inputs.push({ category: DISCOVERY_REASON_CATEGORY, text, source: 'candidate' });
    }
  }
  const ingested = inputs.length > 0 ? await ingestReasons(inputs) : [];

  // 2. Rebuild the candidate's insight with the session in the corpus.
  // Fail-soft: AI budget/outage must not lose the fold (reasons are
  // already banked; the hourly learning job will catch the insight up).
  let insightRebuilt = false;
  try {
    const doc = await rebuildCandidateInsight(String(session.internalCandidateId));
    insightRebuilt = Boolean(doc);
  } catch (err) {
    log.warn(
      { sessionId, error: String(err) },
      'discovery_fold_insight_rebuild_failed',
    );
  }

  log.info(
    { sessionId, reasonsIngested: ingested.length, insightRebuilt },
    'discovery_session_folded',
  );
  return { folded: true, reasonsIngested: ingested.length, insightRebuilt };
}

/**
 * Hourly sweep: flip overdue open sessions to 'expired' and fold the
 * abandoned ones that gathered enough signal.
 */
export async function sweepExpiredSessions(): Promise<{ expired: number; folded: number }> {
  const now = new Date();
  const res = await DiscoverySession.updateMany(
    { status: { $in: ['pending_traits', 'active'] }, expiresAt: { $lt: now } },
    { $set: { status: 'expired' } },
  ).exec();

  const unfolded = await DiscoverySession.find({
    status: 'expired',
    learningFoldedAt: { $exists: false },
  })
    .select('_id cards.verdict')
    .lean()
    .exec();

  let folded = 0;
  for (const row of unfolded) {
    const verdicts = (row.cards ?? []).filter((c) => c.verdict).length;
    if (verdicts < MIN_VERDICTS_TO_FOLD) continue;
    try {
      const result = await foldSessionIntoLearning(String(row._id));
      if (result.folded) folded++;
    } catch (err) {
      log.warn({ sessionId: String(row._id), error: String(err) }, 'discovery_sweep_fold_failed');
    }
  }

  return { expired: res.modifiedCount ?? 0, folded };
}
