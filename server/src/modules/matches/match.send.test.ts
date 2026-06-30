// ═══════════════════════════════════════════════════════════
// sendProposal service tests
//
// These tests verify each gate fires before any socket is touched,
// and that the success/failure paths persist the correct artifacts
// and audit trail.
//
// Mongoose models are mocked + Baileys send is injected via mocking
// whatsapp.service's sendTextFromChannel. AuditLog writes are
// captured and asserted.
// ═══════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { Types } from 'mongoose';

// ── Stateful fakes (populated by vi.mock) ────────────────

interface FakeMatch {
  _id: Types.ObjectId;
  internalCandidateId: Types.ObjectId;
  externalCandidateId: Types.ObjectId;
  status: string;
  sentSideAAt?: Date;
  sentSideBAt?: Date;
  recommendedAction?: string;
  isDeferred?: boolean;
  conversationIds: { sideA?: Types.ObjectId; sideB?: Types.ObjectId };
  sendInFlightSideA?: Date;
  sendInFlightSideB?: Date;
  markModified: (path: string) => void;
  toObject: () => Record<string, unknown>;
  save: () => Promise<FakeMatch>;
}

interface FakeChannel {
  _id: Types.ObjectId;
  channelId: string;
  role: 'profiles_source' | 'match_sending';
  accountDisplayName: string;
  providerSessionId: string;
  status: string;
}

interface FakeConversation {
  _id: Types.ObjectId;
  channelId: string;
  internalCandidateId?: Types.ObjectId;
  externalCandidateId?: Types.ObjectId;
  participantPhone?: string;
  archivedAt?: Date;
}

interface FakeMessage {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  channelId: string;
  direction: string;
  body: string;
  externalMessageId?: string;
  deliveryStatus: string;
  sentAt?: Date;
  failedAt?: Date;
  failureReason?: string;
  createdAt: Date;
}

interface FakeAudit {
  entityType: string;
  entityId: string;
  actionType: string;
  performedBy: string;
  metadata?: Record<string, unknown>;
  before?: unknown;
  after?: unknown;
}

const store = {
  matches: [] as FakeMatch[],
  channels: [] as FakeChannel[],
  conversations: [] as FakeConversation[],
  messages: [] as FakeMessage[],
  audits: [] as FakeAudit[],
};

// ── sendTextFromChannel mock: default succeeds, can be forced to fail ──

let sendResult: { ok: boolean; idOrError: string } = { ok: true, idOrError: 'wamid.outbound-1' };
function setSendOutcome(outcome: { ok: boolean; idOrError: string }) { sendResult = outcome; }

vi.mock('../../services/whatsapp/whatsapp.service.js', () => ({
  sendTextFromChannel: vi.fn(async () => {
    if (!sendResult.ok) throw new Error(sendResult.idOrError);
    return sendResult.idOrError;
  }),
  phoneToJid: (phone: string) => `${phone.replace(/\D/g, '')}@s.whatsapp.net`,
  // Unused in tests but exported by the real module
  channels: {}, conversations: {}, messages: {}, sendMessage: () => { throw new Error('n/a'); },
  channelHealthSummary: async () => [],
}));

// ── Audit capture ────────────────────────────────────────

vi.mock('../../services/audit.service.js', () => ({
  audit: vi.fn(async (input: FakeAudit) => { store.audits.push(input); }),
}));

// ── Safe-mode gate: outbound enabled in tests ────────────
// The real getSafeModeStatus reads the Setting model directly (not via
// the mocked models/index), so without this mock Mongoose buffers the
// query against a non-connected DB and the send path hangs to timeout.
vi.mock('../../services/safe-mode/safe-mode.service.js', () => ({
  getSafeModeStatus: vi.fn(async () => ({
    outboundEnabled: true,
    envEnabled: true,
    settingEnabled: true,
    reason: undefined,
    requireExplicitMapping: false,
  })),
  assertOutboundAllowed: vi.fn(async () => {}),
}));

// ── Model mocks ──────────────────────────────────────────

vi.mock('../../models/index.js', () => {
  const MatchSuggestion = {
    findById: vi.fn((id: string) => ({
      exec: async () => store.matches.find((m) => String(m._id) === String(id)) ?? null,
    })),
    find: vi.fn(() => ({
      select: () => ({ lean: () => ({ exec: async () => [] }) }),
      sort: () => ({ skip: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) }),
      lean: () => ({ exec: async () => [] }),
    })),
    countDocuments: vi.fn(() => ({ exec: async () => 0 })),
    updateOne: vi.fn(() => ({ exec: async () => ({ matchedCount: 0 }) })),
    // Mock the atomic send-claim lock. When the filter asks for a
    // not-yet-sent side, accept the claim and return the live match.
    findOneAndUpdate: vi.fn((filter: Record<string, unknown>) => ({
      exec: async () => {
        const idStr = String((filter['_id'] as { toString: () => string } | undefined)?.toString?.() ?? '');
        const m = store.matches.find((x) => String(x._id) === idStr);
        if (!m) return null;
        // If the filter requires sentSideXAt to not exist and the
        // match has already been sent, reject the claim.
        if ((filter['sentSideAAt'] as { $exists?: boolean } | undefined)?.$exists === false && m.sentSideAAt) return null;
        if ((filter['sentSideBAt'] as { $exists?: boolean } | undefined)?.$exists === false && m.sentSideBAt) return null;
        return m;
      },
    })),
  };

  const Channel = {
    findOne: vi.fn((filter: Record<string, unknown>) => ({
      exec: async () => {
        if (filter['channelId']) return store.channels.find((c) => c.channelId === filter['channelId']) ?? null;
        return null;
      },
    })),
  };

  const Conversation = {
    findOne: vi.fn((filter: Record<string, unknown>) => {
      const sortCache: { key?: string; dir?: number } = {};
      const pipeline = {
        sort: (s: Record<string, number>) => {
          const k = Object.keys(s)[0]; if (k) { sortCache.key = k; sortCache.dir = s[k]; }
          return pipeline;
        },
        exec: async () => {
          const matches = store.conversations.filter((c) => {
            if (filter['channelId'] && c.channelId !== filter['channelId']) return false;
            if (filter['internalCandidateId'] && String(c.internalCandidateId) !== String(filter['internalCandidateId'])) return false;
            if (filter['externalCandidateId'] && String(c.externalCandidateId) !== String(filter['externalCandidateId'])) return false;
            const archivedFilter = filter['archivedAt'];
            if (archivedFilter && typeof archivedFilter === 'object' && '$exists' in archivedFilter) {
              const exists = (archivedFilter as { $exists: boolean }).$exists;
              if (exists === false && c.archivedAt) return false;
            }
            return true;
          });
          return matches[0] ?? null;
        },
      };
      return pipeline;
    }),
    updateOne: vi.fn(() => ({ exec: async () => ({ matchedCount: 1 }) })),
  };

  const Message = {
    create: vi.fn(async (doc: Partial<FakeMessage>) => {
      const rec: FakeMessage = {
        _id: new Types.ObjectId(),
        conversationId: doc.conversationId!,
        channelId: doc.channelId!,
        direction: doc.direction!,
        body: doc.body ?? '',
        externalMessageId: doc.externalMessageId,
        deliveryStatus: doc.deliveryStatus ?? 'pending',
        sentAt: doc.sentAt,
        failedAt: doc.failedAt,
        failureReason: doc.failureReason,
        createdAt: new Date(),
      };
      store.messages.push(rec);
      return rec;
    }),
  };

  const InternalCandidate = {
    findById: vi.fn(() => ({
      lean: () => ({
        exec: async () => ({
          _id: new Types.ObjectId(),
          // All CRITICAL_FIELDS present so computeReadiness returns clean
          firstName: 'David',
          lastName: 'Cohen',
          gender: 'male',
          dateOfBirth: new Date('1998-06-15'),
          sectorGroup: 'dati_leumi',
          readinessForMarriage: 'actively_looking',
          // Recommended fields so profileCompletion >= 60%
          city: 'Jerusalem',
          subSector: 'dati_leumi_classic',
          lifestyleTone: 'moderate',
          lifeStage: 'early_career',
          studyWorkDirection: 'academic_studies',
          about: 'about',
          whatSeeking: 'what seeking',
          photoUrl: 'https://example.com/p.jpg',
          photoApproved: true,
          phone: '972501111111',
          referenceName: 'R',
          referencePhone: '972509999999',
          status: 'active',
        }),
      }),
    })),
  };

  const ExternalCandidate = {
    findById: vi.fn(() => ({
      lean: () => ({
        exec: async () => ({
          _id: new Types.ObjectId(),
          status: 'active',
          availabilityStatus: 'available',
          shareCard: { approvedForShare: true },
        }),
      }),
    })),
  };

  return {
    MatchSuggestion, Channel, Conversation, Message,
    InternalCandidate, ExternalCandidate,
    // other exports unused by this test surface
    AuditLog: {}, AIRequest: {}, Task: {}, Note: {}, User: {},
  };
});

// ── Lazy imports after mocks are registered ──────────────

type MatchSvc = typeof import('./match.service.js');
let sendProposal: MatchSvc['sendProposal'];
const fakeAuthenticatedUserId = new Types.ObjectId().toString();

beforeAll(async () => {
  const mod = await import('./match.service.js');
  sendProposal = mod.sendProposal;
});

function reset(): FakeMatch {
  store.matches.length = 0;
  store.channels.length = 0;
  store.conversations.length = 0;
  store.messages.length = 0;
  store.audits.length = 0;
  setSendOutcome({ ok: true, idOrError: 'wamid.outbound-1' });

  const internalId = new Types.ObjectId();
  const externalId = new Types.ObjectId();
  const matchId = new Types.ObjectId();

  const match: FakeMatch = {
    _id: matchId,
    internalCandidateId: internalId,
    externalCandidateId: externalId,
    status: 'approved',
    recommendedAction: 'send_side_a_first',
    isDeferred: false,
    conversationIds: {},
    markModified() {},
    toObject() { return { ...this, _id: String(this._id) }; },
    save: async function () { return this; },
  };
  store.matches.push(match);

  const channel: FakeChannel = {
    _id: new Types.ObjectId(),
    channelId: 'ch_match_sending_1',
    role: 'match_sending',
    accountDisplayName: 'Match Sender',
    providerSessionId: 'ch_match_sending_1',
    status: 'active',
  };
  store.channels.push(channel);

  const convInternal: FakeConversation = {
    _id: new Types.ObjectId(),
    channelId: channel.channelId,
    internalCandidateId: internalId,
    participantPhone: '972501111111',
  };
  store.conversations.push(convInternal);

  return match;
}

beforeEach(() => { reset(); });

// ══════════════════════════════════════════════════════════
// The tests
// ══════════════════════════════════════════════════════════

describe('sendProposal — gates', () => {
  it('blocks when send-preview says canSend=false (match already closed)', async () => {
    const match = reset();
    match.status = 'closed';

    await expect(sendProposal(String(match._id), {
      side: 'a', channelId: 'ch_match_sending_1', body: 'Hi', performedBy: fakeAuthenticatedUserId,
    })).rejects.toThrow(/not ready to send/i);

    expect(store.messages).toHaveLength(0);
    // No pre-flight audit either — preview gate fired before
    expect(store.audits.filter((a) => a.actionType === 'message_sent')).toHaveLength(0);
  });

  it('blocks when the channel role is profiles_source', async () => {
    const match = reset();
    store.channels[0]!.role = 'profiles_source';

    await expect(sendProposal(String(match._id), {
      side: 'a', channelId: 'ch_match_sending_1', body: 'Hi', performedBy: fakeAuthenticatedUserId,
    })).rejects.toThrow(/match_sending/i);

    expect(store.messages).toHaveLength(0);
  });

  it('blocks when the side is already sent', async () => {
    const match = reset();
    match.sentSideAAt = new Date('2026-04-12T10:00:00Z');

    await expect(sendProposal(String(match._id), {
      side: 'a', channelId: 'ch_match_sending_1', body: 'Hi', performedBy: fakeAuthenticatedUserId,
    })).rejects.toThrow(/already received/i);
  });

  it('blocks when no conversation exists on this channel for the side', async () => {
    const match = reset();
    store.conversations.length = 0; // no conversation set up

    await expect(sendProposal(String(match._id), {
      side: 'a', channelId: 'ch_match_sending_1', body: 'Hi', performedBy: fakeAuthenticatedUserId,
    })).rejects.toThrow(/no reachable conversation/i);
  });
});

describe('sendProposal — success path', () => {
  it('persists outbound Message, stamps match, writes full audit trail', async () => {
    const match = reset();
    const res = await sendProposal(String(match._id), {
      side: 'a', channelId: 'ch_match_sending_1', body: 'Shalom!',
      performedBy: fakeAuthenticatedUserId,
    });

    // Return value shape
    expect(res.externalMessageId).toBe('wamid.outbound-1');
    expect(res.matchStatus).toBe('sent_side_a');

    // Exactly one Message row in SENT state
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]!.direction).toBe('outbound');
    expect(store.messages[0]!.deliveryStatus).toBe('sent');
    expect(store.messages[0]!.externalMessageId).toBe('wamid.outbound-1');

    // Match advanced
    expect(store.matches[0]!.sentSideAAt).toBeInstanceOf(Date);
    expect(store.matches[0]!.status).toBe('sent_side_a');

    // Audit: attempt → MATCH_SENT → success
    const stages = store.audits.map((a) => a.metadata?.['stage'] ?? a.actionType);
    expect(stages).toEqual(expect.arrayContaining(['attempt', 'match_sent', 'success']));
  });

  it('transitions to sent_both when the other side was already sent', async () => {
    const match = reset();
    match.sentSideBAt = new Date('2026-04-10T10:00:00Z');
    store.conversations.push({
      _id: new Types.ObjectId(),
      channelId: 'ch_match_sending_1',
      externalCandidateId: match.externalCandidateId,
      participantPhone: '972502222222',
    });

    const res = await sendProposal(String(match._id), {
      side: 'a', channelId: 'ch_match_sending_1', body: 'Hi',
      performedBy: fakeAuthenticatedUserId,
    });

    expect(res.matchStatus).toBe('sent_both');
  });
});

describe('sendProposal — failure path', () => {
  it('persists a FAILED Message when Baileys send throws, and audits stage=failed', async () => {
    const match = reset();
    setSendOutcome({ ok: false, idOrError: 'socket not connected' });

    await expect(sendProposal(String(match._id), {
      side: 'a', channelId: 'ch_match_sending_1', body: 'Hi',
      performedBy: fakeAuthenticatedUserId,
    })).rejects.toThrow(/send failed/i);

    // Failure artefact visible in the thread
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]!.deliveryStatus).toBe('failed');
    expect(store.messages[0]!.failedAt).toBeInstanceOf(Date);
    expect(store.messages[0]!.failureReason).toContain('socket not connected');
    expect(store.messages[0]!.externalMessageId).toBeUndefined();

    // Match NOT advanced
    expect(store.matches[0]!.sentSideAAt).toBeUndefined();
    expect(store.matches[0]!.status).toBe('approved');

    // Audit: attempt + failed (NOT match_sent, NOT success)
    const stages = store.audits.map((a) => String(a.metadata?.['stage'] ?? a.actionType));
    expect(stages).toContain('attempt');
    expect(stages).toContain('failed');
    expect(stages).not.toContain('success');
    expect(stages).not.toContain('match_sent');
  });
});
