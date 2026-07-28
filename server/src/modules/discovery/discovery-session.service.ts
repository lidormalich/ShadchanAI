// ═══════════════════════════════════════════════════════════
// Discovery session service — mint / resolve / manage the public
// "היכרות חכמה" swipe links.
//
// Token model mirrors the public photo link (candidate-photo.service):
// 24 random bytes base64url (~32 chars, 192 bits) — unguessable,
// revocable by regeneration. Expiry is SOFT: resolveActiveSession
// flips status lazily; the hourly job sweeps the rest. Data is never
// deleted — it is the learning corpus.
// ═══════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { InternalCandidate, ExternalCandidate } from '../../models/index.js';
import { DiscoverySession, type IDiscoverySession } from './discovery-session.model.js';
import { getSettingCached } from '../settings/settings.service.js';
import { NotFoundError, BusinessRuleError } from '../../utils/errors.js';

// Same shape the public photo route accepts — one public-token grammar.
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const OPEN_STATUSES = ['pending_traits', 'active'] as const;

function mintToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export interface CreateSessionResult {
  session: IDiscoverySession;
  /** Relative path — the controller prefixes the deploy base URL. */
  path: string;
}

export function meetPath(token: string): string {
  return `/meet/${token}`;
}

export async function createSession(
  internalCandidateId: string,
  createdBy: string,
): Promise<CreateSessionResult> {
  const enabled = await getSettingCached('discovery.enabled');
  if (!enabled) throw new BusinessRuleError('היכרות חכמה כבויה בהגדרות');

  const internal = await InternalCandidate.findById(internalCandidateId)
    .select('firstName status')
    .lean()
    .exec();
  if (!internal) throw new NotFoundError('InternalCandidate', internalCandidateId);

  // One open link per candidate: a fresh link supersedes (revokes) any
  // previous one, so a leaked older link can't keep serving cards.
  await DiscoverySession.updateMany(
    {
      internalCandidateId: new Types.ObjectId(internalCandidateId),
      status: { $in: OPEN_STATUSES },
    },
    { $set: { status: 'revoked' } },
  ).exec();

  const ttlDays = Number(await getSettingCached('discovery.session_ttl_days'));
  const session = await DiscoverySession.create({
    token: mintToken(),
    internalCandidateId: new Types.ObjectId(internalCandidateId),
    status: 'pending_traits',
    expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
    createdBy: new Types.ObjectId(createdBy),
  });

  return { session, path: meetPath(session.token) };
}

export type ResolveResult =
  | { kind: 'ok'; session: IDiscoverySession }
  | { kind: 'expired' }
  | { kind: 'not_found' }
  | { kind: 'disabled' };

/**
 * Shared guard for every public endpoint. Never throws for bad tokens —
 * the public page needs distinguishable friendly states, not a stack of
 * error codes.
 */
export async function resolveActiveSession(token: string): Promise<ResolveResult> {
  if (!TOKEN_RE.test(token)) return { kind: 'not_found' };

  const enabled = await getSettingCached('discovery.enabled');
  if (!enabled) return { kind: 'disabled' };

  const session = await DiscoverySession.findOne({ token }).exec();
  if (!session || session.status === 'revoked') return { kind: 'not_found' };

  if (session.status === 'expired') return { kind: 'expired' };
  if (session.expiresAt.getTime() < Date.now() && session.status !== 'completed') {
    // Lazy flip — the hourly job would catch it anyway; doing it here
    // keeps the status truthful for the operator panel immediately.
    session.status = 'expired';
    await session.save();
    return { kind: 'expired' };
  }

  return { kind: 'ok', session };
}

// ── Operator-facing reads ────────────────────────────────

export interface SessionListItem {
  id: string;
  status: IDiscoverySession['status'];
  expiresAt: Date;
  counters: IDiscoverySession['counters'];
  createdAt: Date;
  finishedAt?: Date | undefined;
  pendingReview: boolean;
  path: string;
}

export async function listSessions(internalCandidateId: string): Promise<SessionListItem[]> {
  const rows = await DiscoverySession.find({
    internalCandidateId: new Types.ObjectId(internalCandidateId),
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .select('status expiresAt counters createdAt finishedAt operatorViewedAt token')
    .lean()
    .exec();

  return rows.map((r) => ({
    id: String(r._id),
    status: r.status,
    expiresAt: r.expiresAt,
    counters: r.counters,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt ?? undefined,
    pendingReview: r.status === 'completed' && !r.operatorViewedAt,
    path: meetPath(r.token),
  }));
}

export interface OperatorCardView {
  cardId: string;
  externalCandidateId: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  age?: number | undefined;
  city?: string | undefined;
  sectorGroup?: string | undefined;
  batchIndex: number;
  engineScore: number;
  verdict?: string | undefined;
  reasonChips?: string[] | undefined;
  reasonText?: string | undefined;
  verdictAt?: Date | undefined;
}

export async function getSessionForOperator(id: string): Promise<{
  id: string;
  internalCandidateId: string;
  status: IDiscoverySession['status'];
  expiresAt: Date;
  createdAt: Date;
  finishedAt?: Date | undefined;
  counters: IDiscoverySession['counters'];
  wizard?: IDiscoverySession['wizard'];
  traitPicks?: IDiscoverySession['traitPicks'];
  aiSummaries: IDiscoverySession['aiSummaries'];
  cards: OperatorCardView[];
  path: string;
}> {
  const session = await DiscoverySession.findById(id).exec();
  if (!session) throw new NotFoundError('DiscoverySession', id);

  // Opening the detail clears the "ממתין לסקירה" badge.
  if (session.status === 'completed' && !session.operatorViewedAt) {
    session.operatorViewedAt = new Date();
    await session.save();
  }

  // The operator view resolves real identities — this endpoint is
  // auth-gated; the public DTO never includes these.
  const externalIds = session.cards.map((c) => c.externalCandidateId);
  const externals = await ExternalCandidate.find({ _id: { $in: externalIds } })
    .select('firstName lastName age city sectorGroup')
    .lean()
    .exec();
  const byId = new Map(externals.map((e) => [String(e._id), e]));

  const cards: OperatorCardView[] = session.cards.map((c) => {
    const ext = byId.get(String(c.externalCandidateId));
    return {
      cardId: c.cardId,
      externalCandidateId: String(c.externalCandidateId),
      firstName: ext?.firstName,
      lastName: ext?.lastName,
      age: ext?.age,
      city: ext?.city,
      sectorGroup: ext?.sectorGroup,
      batchIndex: c.batchIndex,
      engineScore: c.engineScore,
      verdict: c.verdict,
      reasonChips: c.reasonChips,
      reasonText: c.reasonText,
      verdictAt: c.verdictAt,
    };
  });

  return {
    id: String(session._id),
    internalCandidateId: String(session.internalCandidateId),
    status: session.status,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    finishedAt: session.finishedAt ?? undefined,
    counters: session.counters,
    wizard: session.wizard,
    traitPicks: session.traitPicks,
    aiSummaries: session.aiSummaries,
    cards,
    path: meetPath(session.token),
  };
}

export async function revokeSession(id: string): Promise<{ id: string; status: string }> {
  const session = await DiscoverySession.findById(id).exec();
  if (!session) throw new NotFoundError('DiscoverySession', id);
  if (session.status === 'completed') {
    throw new BusinessRuleError('סשן שהסתיים אינו ניתן לביטול — הקישור כבר לא פעיל');
  }
  session.status = 'revoked';
  await session.save();
  return { id: String(session._id), status: session.status };
}

/**
 * Rotates the token and extends expiry. The old link dies instantly
 * (token lookup fails); progress inside the session is preserved.
 */
export async function regenerateSession(id: string): Promise<{
  id: string; status: string; expiresAt: Date; path: string;
}> {
  const session = await DiscoverySession.findById(id).exec();
  if (!session) throw new NotFoundError('DiscoverySession', id);
  if (session.status === 'completed') {
    throw new BusinessRuleError('סשן שהסתיים אינו ניתן לחידוש — צרו קישור חדש');
  }

  const ttlDays = Number(await getSettingCached('discovery.session_ttl_days'));
  session.token = mintToken();
  session.expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  if (session.status === 'expired' || session.status === 'revoked') {
    // Re-opening: resume where the candidate left off.
    session.status = session.traitPicks ? 'active' : 'pending_traits';
  }
  await session.save();
  return {
    id: String(session._id),
    status: session.status,
    expiresAt: session.expiresAt,
    path: meetPath(session.token),
  };
}
