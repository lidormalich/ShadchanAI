// ═══════════════════════════════════════════════════════════
// Discovery Router (operator-facing, auth-gated)
//
// Mint / list / inspect / revoke the public "היכרות חכמה" links.
// The public candidate-facing surface lives in
// discovery-public.router.ts — deliberately a separate router with
// its own rate limiter and no auth.
// ═══════════════════════════════════════════════════════════

import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { ensureUser } from '../../middleware/permissions.js';
import { validate, getValidatedParams, getValidatedQuery } from '../../middleware/validate.middleware.js';
import { ok, created } from '../../utils/response.js';
import { env } from '../../config/env.js';
import {
  CreateSessionSchema,
  ListSessionsQuerySchema,
  IdParamSchema,
  ApplyProposalSchema,
} from './discovery.validator.js';
import {
  createSession,
  listSessions,
  getSessionForOperator,
  revokeSession,
  regenerateSession,
} from './discovery-session.service.js';
import { rankByRevealedPreferences } from './discovery-ranking.service.js';
import { buildProfileProposal, applyProfileProposal } from './discovery-profile.service.js';

export const discoveryRouter = Router();
discoveryRouter.use(requireAuth);

// Absolute link the operator copies into WhatsApp. PUBLIC_BASE_URL wins
// (operator may be on localhost); falls back to the request origin.
function baseUrl(req: Request): string {
  return (env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

discoveryRouter.post(
  '/sessions',
  validate({ body: CreateSessionSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = ensureUser(req.user);
      const { internalCandidateId } = req.body as { internalCandidateId: string };
      const { session, path } = await createSession(internalCandidateId, user.id);
      created(res, {
        id: String(session._id),
        status: session.status,
        expiresAt: session.expiresAt,
        url: `${baseUrl(req)}${path}`,
      });
    } catch (e) { next(e); }
  },
);

discoveryRouter.get(
  '/sessions',
  validate({ query: ListSessionsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ensureUser(req.user);
      const { internalCandidateId } = getValidatedQuery<{ internalCandidateId: string }>(req);
      const rows = await listSessions(internalCandidateId);
      const base = baseUrl(req);
      ok(res, rows.map(({ path, ...row }) => ({ ...row, url: `${base}${path}` })));
    } catch (e) { next(e); }
  },
);

discoveryRouter.get(
  '/sessions/:id',
  validate({ params: IdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ensureUser(req.user);
      const { id } = getValidatedParams<{ id: string }>(req);
      const { path, ...detail } = await getSessionForOperator(id);
      ok(res, { ...detail, url: `${baseUrl(req)}${path}` });
    } catch (e) { next(e); }
  },
);

// Rank the external pool by the candidate's REVEALED preferences
// (aggregated swipe verdicts + latest AI summary) — the operator's
// "לפי ההיכרות" tab. Real identities; auth-gated.
discoveryRouter.get(
  '/preference-ranking',
  validate({ query: ListSessionsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ensureUser(req.user);
      const { internalCandidateId } = getValidatedQuery<{ internalCandidateId: string }>(req);
      ok(res, await rankByRevealedPreferences(internalCandidateId));
    } catch (e) { next(e); }
  },
);

// Apply revealed preferences to the profile: GET builds the proposed
// change list; POST applies the operator-accepted subset (keys only —
// values are rebuilt server-side). Routes through the normal candidate
// update path so audit + readiness + embedding invalidation all fire.
discoveryRouter.get(
  '/profile-proposal',
  validate({ query: ListSessionsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ensureUser(req.user);
      const { internalCandidateId } = getValidatedQuery<{ internalCandidateId: string }>(req);
      ok(res, await buildProfileProposal(internalCandidateId));
    } catch (e) { next(e); }
  },
);

discoveryRouter.post(
  '/profile-proposal/apply',
  validate({ body: ApplyProposalSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = ensureUser(req.user);
      const { internalCandidateId, accept } = req.body as { internalCandidateId: string; accept: string[] };
      ok(res, await applyProfileProposal(internalCandidateId, accept, user));
    } catch (e) { next(e); }
  },
);

discoveryRouter.post(
  '/sessions/:id/revoke',
  validate({ params: IdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ensureUser(req.user);
      const { id } = getValidatedParams<{ id: string }>(req);
      ok(res, await revokeSession(id));
    } catch (e) { next(e); }
  },
);

discoveryRouter.post(
  '/sessions/:id/regenerate',
  validate({ params: IdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      ensureUser(req.user);
      const { id } = getValidatedParams<{ id: string }>(req);
      const { path, ...result } = await regenerateSession(id);
      ok(res, { ...result, url: `${baseUrl(req)}${path}` });
    } catch (e) { next(e); }
  },
);
