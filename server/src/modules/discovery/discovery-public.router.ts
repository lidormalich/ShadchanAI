// ═══════════════════════════════════════════════════════════
// Discovery PUBLIC router — the candidate-facing "היכרות חכמה"
// surface. NO login: the unguessable session token is the only
// credential (same trust model as the public photo link).
//
// Response convention: every endpoint answers HTTP 200 with a
// `state` discriminator ('ok' | 'invalid' | 'expired' | 'disabled')
// instead of 4xx codes — the public page is a friendly state machine,
// not an API client, and an expired link is a normal state, not an
// error.
//
// PII: only DiscoveryCardDTO crosses this boundary (no names, no
// city, no raw ids). The internal candidate contributes exactly one
// field: their first name for the greeting.
// ═══════════════════════════════════════════════════════════

import { Router, type Request, type Response, type NextFunction } from 'express';
import sharp from 'sharp';
import { ExternalCandidate } from '../../models/index.js';
import { DiscoverySession, type IDiscoverySession } from './discovery-session.model.js';
import { resolveActiveSession, type ResolveResult } from './discovery-session.service.js';
import { buildDiscoveryBatch, dtosForExistingCards } from './discovery-ranking.service.js';
import { maybeRefineSession, generateWizard } from './discovery-ai.service.js';
import { foldSessionIntoLearning, DISCOVERY_REASON_CATEGORY } from './discovery-learning.service.js';
import { listReasons } from '../rejection-reasons/rejection-reason.service.js';
import { readCandidatePhoto } from '../../services/storage/candidate-photo.service.js';
import { InternalCandidate } from '../../models/index.js';
import { getSettingCached } from '../settings/settings.service.js';
import { validate, getValidatedParams } from '../../middleware/validate.middleware.js';
import { ok } from '../../utils/response.js';
import {
  TokenParamSchema,
  SubmitTraitsSchema,
  SubmitVerdictSchema,
  PhotoParamSchema,
} from './discovery.validator.js';
import { sanitizeTraitPicks, STARTER_REJECT_CHIPS } from './discovery-vocab.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('discovery.public');

export const discoveryPublicRouter = Router();

// ── Helpers ──────────────────────────────────────────────

function badState(res: Response, result: Exclude<ResolveResult, { kind: 'ok' }>): void {
  const state = result.kind === 'not_found' ? 'invalid' : result.kind;
  ok(res, { state });
}

function unansweredCurrentBatch(session: IDiscoverySession) {
  return session.cards.filter(
    (c) => c.batchIndex === session.currentBatchIndex && !c.verdict,
  );
}

async function rejectChips(): Promise<string[]> {
  try {
    const bank = await listReasons({ category: DISCOVERY_REASON_CATEGORY, limit: 8 });
    const merged = [...bank.map((r) => r.text), ...STARTER_REJECT_CHIPS];
    return [...new Set(merged)].slice(0, 10);
  } catch {
    return STARTER_REJECT_CHIPS;
  }
}

function stepOf(session: IDiscoverySession): 'traits' | 'swiping' | 'done' {
  if (session.status === 'pending_traits') return 'traits';
  if (session.status === 'completed') return 'done';
  return 'swiping';
}

async function progressOf(session: IDiscoverySession) {
  const maxCards = Number(await getSettingCached('discovery.max_cards_per_session'));
  return {
    served: session.counters.served,
    liked: session.counters.liked,
    rejected: session.counters.rejected,
    remaining: Math.max(0, maxCards - session.counters.served),
  };
}

// ── GET /:token — session state (entry point / refresh) ──

discoveryPublicRouter.get(
  '/:token',
  validate({ params: TokenParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = getValidatedParams<{ token: string }>(req);
      const result = await resolveActiveSession(token);
      if (result.kind !== 'ok') return badState(res, result);
      const session = result.session;

      const internal = await InternalCandidate.findById(session.internalCandidateId)
        .select('firstName')
        .lean()
        .exec();

      // Lazy wizard generation on first open — AI budget is only spent
      // if the candidate actually opens the link.
      if (session.status === 'pending_traits' && !session.wizard) {
        const wizard = await generateWizard(session);
        session.wizard = wizard;
        await DiscoverySession.updateOne(
          { _id: session._id, wizard: { $exists: false } },
          { $set: { wizard } },
        ).exec();
      }

      const open = unansweredCurrentBatch(session);
      ok(res, {
        state: 'ok',
        status: session.status,
        step: stepOf(session),
        firstName: internal?.firstName ?? '',
        wizard: session.status === 'pending_traits' ? session.wizard : undefined,
        progress: await progressOf(session),
        currentBatch: open.length > 0 ? await dtosForExistingCards(session, open) : undefined,
        rejectChips: await rejectChips(),
      });
    } catch (e) { next(e); }
  },
);

// ── POST /:token/traits — submit the wizard answers ──────

discoveryPublicRouter.post(
  '/:token/traits',
  validate({ params: TokenParamSchema, body: SubmitTraitsSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = getValidatedParams<{ token: string }>(req);
      const result = await resolveActiveSession(token);
      if (result.kind !== 'ok') return badState(res, result);
      const session = result.session;

      // Idempotent: a re-submit after the wizard already closed is a
      // refresh artifact, not an error.
      if (session.status !== 'pending_traits') {
        return ok(res, { state: 'ok', status: session.status });
      }

      // The vocabulary is the gate — whatever the client sent, only
      // known fields/values survive.
      const picks = sanitizeTraitPicks(req.body as Parameters<typeof sanitizeTraitPicks>[0]);
      session.traitPicks = picks;
      session.status = 'active';
      await session.save();

      ok(res, { state: 'ok', status: session.status });
    } catch (e) { next(e); }
  },
);

// ── POST /:token/batch — serve the next card batch ───────

discoveryPublicRouter.post(
  '/:token/batch',
  validate({ params: TokenParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = getValidatedParams<{ token: string }>(req);
      const result = await resolveActiveSession(token);
      if (result.kind !== 'ok') return badState(res, result);
      let session = result.session;

      if (session.status !== 'active') {
        return ok(res, { state: 'ok', status: session.status, cards: [], exhausted: true });
      }

      // Idempotency: an unfinished batch is re-served as-is (refresh /
      // double-tap), never regenerated.
      const open = unansweredCurrentBatch(session);
      if (open.length > 0) {
        return ok(res, {
          state: 'ok',
          batchIndex: session.currentBatchIndex,
          cards: await dtosForExistingCards(session, open),
          exhausted: false,
          refined: false,
        });
      }

      const maxCards = Number(await getSettingCached('discovery.max_cards_per_session'));
      if (session.counters.served >= maxCards) {
        return ok(res, { state: 'ok', batchIndex: session.currentBatchIndex, cards: [], exhausted: true });
      }

      // Refine BEFORE generating so the new batch sees the freshest
      // summary. Skips itself quietly when there's nothing new / no AI.
      const summariesBefore = session.aiSummaries.length;
      await maybeRefineSession(session);

      // Atomic batch claim — the loser of a double-tap race re-reads
      // and serves the winner's batch instead of generating its own.
      const claimed = await DiscoverySession.findOneAndUpdate(
        { _id: session._id, currentBatchIndex: session.currentBatchIndex },
        { $inc: { currentBatchIndex: 1 } },
        { new: true },
      ).exec();

      if (!claimed) {
        const fresh = await DiscoverySession.findById(session._id).exec();
        if (!fresh) return ok(res, { state: 'invalid' });
        const freshOpen = unansweredCurrentBatch(fresh);
        return ok(res, {
          state: 'ok',
          batchIndex: fresh.currentBatchIndex,
          cards: await dtosForExistingCards(fresh, freshOpen),
          exhausted: freshOpen.length === 0,
          refined: false,
        });
      }

      session = claimed;
      const batch = await buildDiscoveryBatch(session, session.currentBatchIndex);
      ok(res, {
        state: 'ok',
        batchIndex: batch.batchIndex,
        cards: batch.cards,
        exhausted: batch.exhausted,
        refined: session.aiSummaries.length > summariesBefore,
      });
    } catch (e) { next(e); }
  },
);

// ── POST /:token/verdict — record one swipe ──────────────

const COUNTER_BY_VERDICT: Record<string, string> = {
  like: 'counters.liked',
  reject: 'counters.rejected',
  skip: 'counters.skipped',
};

discoveryPublicRouter.post(
  '/:token/verdict',
  validate({ params: TokenParamSchema, body: SubmitVerdictSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = getValidatedParams<{ token: string }>(req);
      const result = await resolveActiveSession(token);
      if (result.kind !== 'ok') return badState(res, result);
      const session = result.session;

      const { cardId, verdict, reasonChips: chips, reasonText } = req.body as {
        cardId: string; verdict: 'like' | 'reject' | 'skip';
        reasonChips?: string[]; reasonText?: string;
      };

      // Atomic first-write-wins: a mobile retry / double-tap of an
      // already-answered card is a 200 no-op, and counters move once.
      const updated = await DiscoverySession.findOneAndUpdate(
        {
          _id: session._id,
          cards: { $elemMatch: { cardId, verdict: { $exists: false } } },
        },
        {
          $set: {
            'cards.$.verdict': verdict,
            ...(verdict === 'reject' && chips?.length ? { 'cards.$.reasonChips': chips } : {}),
            ...(verdict === 'reject' && reasonText ? { 'cards.$.reasonText': reasonText } : {}),
            'cards.$.verdictAt': new Date(),
          },
          $inc: { [COUNTER_BY_VERDICT[verdict]!]: 1 },
        },
        { new: true },
      ).exec();

      if (!updated) {
        // Either the cardId isn't in this session (tampering / stale
        // client) or the verdict already landed. Both are terminal 200s.
        const known = session.cards.some((c) => c.cardId === cardId);
        return ok(res, {
          state: 'ok',
          recorded: false,
          alreadyRecorded: known,
          batchComplete: false,
        });
      }

      const batchComplete = unansweredCurrentBatch(updated).length === 0;
      ok(res, { state: 'ok', recorded: true, alreadyRecorded: false, batchComplete });
    } catch (e) { next(e); }
  },
);

// ── POST /:token/finish — close the session ──────────────

discoveryPublicRouter.post(
  '/:token/finish',
  validate({ params: TokenParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = getValidatedParams<{ token: string }>(req);
      const result = await resolveActiveSession(token);
      if (result.kind !== 'ok') return badState(res, result);
      const session = result.session;

      if (session.status === 'active' || session.status === 'pending_traits') {
        session.status = 'completed';
        session.finishedAt = new Date();
        await session.save();
        // Fold into the operator learning loop off the request path —
        // the candidate shouldn't wait on an AI insight rebuild.
        void foldSessionIntoLearning(String(session._id)).catch((err) => {
          log.warn({ sessionId: String(session._id), error: String(err) }, 'finish_fold_failed');
        });
      }

      // "מה הבנו עליך" — the candidate sees the digest of their OWN
      // revealed preferences (their data, no third-party PII).
      const latest = session.aiSummaries.at(-1);
      ok(res, {
        state: 'ok',
        status: 'completed',
        insights: {
          liked: session.counters.liked,
          rejected: session.counters.rejected,
          total: session.counters.served,
          learnedSummary: latest?.summary,
          learnedSignals: latest?.positiveSignals?.slice(0, 5) ?? [],
        },
      });
    } catch (e) { next(e); }
  },
);

// ── GET /:token/photo/:cardId — blurred card photo ───────
//
// Served ONLY when the external's shareCard is approved for sharing
// with a photo mode. ALWAYS blurred server-side in v1 (a CSS blur
// could be removed in devtools; sharp's can't) — even photoMode
// 'full' renders blurred on the anonymous card.

discoveryPublicRouter.get(
  '/:token/photo/:cardId',
  validate({ params: PhotoParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, cardId } = getValidatedParams<{ token: string; cardId: string }>(req);
      const result = await resolveActiveSession(token);
      if (result.kind !== 'ok') { res.status(404).end(); return; }
      const session = result.session;

      const card = session.cards.find((c) => c.cardId === cardId);
      if (!card?.hasPhoto) { res.status(404).end(); return; }

      const ext = await ExternalCandidate.findById(card.externalCandidateId)
        .select('photoStorageKey shareCard')
        .lean()
        .exec();
      const approved = ext?.shareCard?.approvedForShare
        && (ext.shareCard.photoMode === 'blurred' || ext.shareCard.photoMode === 'full');
      if (!ext?.photoStorageKey || !approved) { res.status(404).end(); return; }

      const photo = await readCandidatePhoto(ext.photoStorageKey);
      if (!photo) { res.status(404).end(); return; }

      const blurred = await sharp(photo.data)
        .resize(256, 256, { fit: 'cover' })
        .blur(18)
        .jpeg({ quality: 70 })
        .toBuffer();

      res.setHeader('Content-Type', 'image/jpeg');
      // Private: the URL embeds the session token — never let a shared
      // cache serve it to another client.
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(blurred);
    } catch (e) { next(e); }
  },
);
