// ═══════════════════════════════════════════════════════════
// ShadchanAI — WhatsApp Handler Tests
//
// Covers:
//   - Inbound message storage with idempotency on duplicate
//     externalMessageId (both pre-check and race E11000 paths)
//   - Conversation creation on first inbound for a channel+phone
//   - Conversation continuity (supersedesConversationId,
//     replacedChannelOriginId) when a channel is a replacement
//   - Role-based channel routing (profiles_source vs match_sending)
//   - Unknown channel → skip with reason
//   - Replace-account lifecycle: old channel history NOT merged
//   - Intentional disconnect doesn't delete history
//
// Models are mocked via vi.mock so tests run without a real
// MongoDB instance.
// ═══════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { Types } from 'mongoose';

// ── Stateful in-memory fake stores ───────────────────────

interface FakeChannel {
  _id: Types.ObjectId;
  channelId: string;
  role: string;
  accountDisplayName: string;
  phoneNumber: string;
  provider: string;
  providerSessionId: string;
  tokenRef: string;
  status: string;
  connectionHealth: string;
  webhookStatus: string;
  lastConnectedAt?: Date;
  lastInboundAt?: Date;
  lastOutboundAt?: Date;
  replacedByChannelId?: string;
  replacesChannelId?: string;
  save: () => Promise<FakeChannel>;
}

interface FakeConversation {
  _id: Types.ObjectId;
  channelId: string;
  channelRole: string;
  accountDisplayName: string;
  participantPhone?: string;
  participantName?: string;
  internalCandidateId?: Types.ObjectId;
  externalCandidateId?: Types.ObjectId;
  matchSuggestionId?: Types.ObjectId;
  purpose: string;
  isActive: boolean;
  needsAction: boolean;
  unreadCount: number;
  lastMessageAt?: Date;
  lastInboundAt?: Date;
  supersedesConversationId?: Types.ObjectId;
  replacedChannelOriginId?: string;
  archivedAt?: Date;
  createdAt: Date;
}

interface FakeMessage {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  channelId: string;
  channelRole: string;
  accountDisplayName: string;
  direction: string;
  contentType: string;
  body?: string;
  externalMessageId?: string;
  providerSessionId?: string;
  deliveryStatus: string;
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
  failedAt?: Date;
  failureReason?: string;
  rawPayload?: unknown;
  createdAt: Date;
}

const store = {
  channels: [] as FakeChannel[],
  conversations: [] as FakeConversation[],
  messages: [] as FakeMessage[],
};

function resetStore() {
  store.channels.length = 0;
  store.conversations.length = 0;
  store.messages.length = 0;
}

// ── Mock the models module ───────────────────────────────

vi.mock('../../models/index.js', () => {
  // ── Channel mock ─────────────────────────────────────
  const Channel = {
    create: vi.fn(async (doc: Partial<FakeChannel>) => {
      const rec: FakeChannel = {
        _id: new Types.ObjectId(),
        channelId: doc.channelId!,
        role: doc.role!,
        accountDisplayName: doc.accountDisplayName!,
        phoneNumber: doc.phoneNumber ?? '',
        provider: doc.provider ?? 'whatsapp_cloud',
        providerSessionId: doc.providerSessionId ?? '',
        tokenRef: doc.tokenRef ?? '',
        status: doc.status ?? 'active',
        connectionHealth: doc.connectionHealth ?? 'healthy',
        webhookStatus: doc.webhookStatus ?? 'pending',
        lastConnectedAt: doc.lastConnectedAt,
        replacesChannelId: doc.replacesChannelId,
        save: async function () { return this; },
      };
      store.channels.push(rec);
      return rec;
    }),
    findOne: vi.fn((filter: Record<string, unknown>) => ({
      exec: async () => findChannel(filter),
      lean: () => ({ exec: async () => findChannel(filter) }),
      select: () => ({ lean: () => ({ exec: async () => findChannel(filter) }) }),
    })),
    findOneAndUpdate: vi.fn((filter: Record<string, unknown>, update: Record<string, unknown>) => ({
      exec: async () => {
        const ch = findChannel(filter);
        if (!ch) return null;
        const set = (update['$set'] ?? {}) as Record<string, unknown>;
        Object.assign(ch, set);
        return ch;
      },
    })),
    updateOne: vi.fn((filter: Record<string, unknown>, update: Record<string, unknown>) => ({
      exec: async () => {
        const ch = findChannel(filter);
        if (ch) Object.assign(ch, update['$set'] ?? {});
        return { matchedCount: ch ? 1 : 0 };
      },
    })),
    find: vi.fn(() => ({ lean: () => ({ exec: async () => store.channels }) })),
  };

  function findChannel(filter: Record<string, unknown>): FakeChannel | null {
    return store.channels.find((c) => {
      if (filter['channelId'] && c.channelId !== filter['channelId']) return false;
      if (filter['providerSessionId'] && c.providerSessionId !== filter['providerSessionId']) return false;
      if (filter['role'] && c.role !== filter['role']) return false;
      if (filter['status'] && typeof filter['status'] === 'object' && filter['status'] !== null) {
        const inClause = (filter['status'] as { $in?: string[] }).$in;
        if (inClause && !inClause.includes(c.status)) return false;
      } else if (filter['status'] && c.status !== filter['status']) {
        return false;
      }
      return true;
    }) ?? null;
  }

  // ── Conversation mock ─────────────────────────────────
  const Conversation = {
    create: vi.fn(async (doc: Partial<FakeConversation>) => {
      const rec: FakeConversation = {
        _id: new Types.ObjectId(),
        channelId: doc.channelId!,
        channelRole: doc.channelRole!,
        accountDisplayName: doc.accountDisplayName!,
        participantPhone: doc.participantPhone,
        participantName: doc.participantName,
        internalCandidateId: doc.internalCandidateId,
        externalCandidateId: doc.externalCandidateId,
        matchSuggestionId: doc.matchSuggestionId,
        purpose: doc.purpose ?? 'general',
        isActive: doc.isActive ?? true,
        needsAction: doc.needsAction ?? false,
        unreadCount: doc.unreadCount ?? 0,
        supersedesConversationId: doc.supersedesConversationId,
        replacedChannelOriginId: doc.replacedChannelOriginId,
        createdAt: new Date(),
      };
      store.conversations.push(rec);
      return rec;
    }),
    findOne: vi.fn((filter: Record<string, unknown>) => {
      const sortObj: { key?: string; dir?: number } = {};
      const pipeline = {
        sort: (s: Record<string, number>) => {
          const k = Object.keys(s)[0];
          if (k) { sortObj.key = k; sortObj.dir = s[k]; }
          return pipeline;
        },
        exec: async () => findConversation(filter, sortObj),
        lean: () => ({ exec: async () => findConversation(filter, sortObj) }),
      };
      return pipeline;
    }),
    findById: vi.fn((id: Types.ObjectId | string) => ({
      exec: async () => store.conversations.find((c) => String(c._id) === String(id)) ?? null,
    })),
    updateOne: vi.fn((filter: Record<string, unknown>, update: Record<string, unknown>) => ({
      exec: async () => {
        const conv = store.conversations.find((c) => String(c._id) === String(filter['_id']));
        if (conv) {
          Object.assign(conv, (update['$set'] ?? {}) as Record<string, unknown>);
          const inc = (update['$inc'] ?? {}) as Record<string, number>;
          for (const [k, v] of Object.entries(inc)) {
            (conv as unknown as Record<string, number>)[k] = ((conv as unknown as Record<string, number>)[k] ?? 0) + v;
          }
        }
        return { matchedCount: conv ? 1 : 0 };
      },
    })),
    find: vi.fn(() => ({
      sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => store.conversations }) }) }),
    })),
  };

  function findConversation(
    filter: Record<string, unknown>,
    sortObj: { key?: string; dir?: number },
  ): FakeConversation | null {
    let matches = store.conversations.filter((c) => {
      if (filter['channelId'] && c.channelId !== filter['channelId']) return false;
      if (filter['channelRole'] && c.channelRole !== filter['channelRole']) return false;
      if (filter['participantPhone'] && c.participantPhone !== filter['participantPhone']) return false;
      const archivedFilter = filter['archivedAt'];
      if (archivedFilter && typeof archivedFilter === 'object' && '$exists' in archivedFilter) {
        const exists = (archivedFilter as { $exists: boolean }).$exists;
        if (exists === false && c.archivedAt) return false;
      }
      return true;
    });
    if (sortObj.key) {
      matches = matches.sort((a, b) => {
        const av = (a as unknown as Record<string, unknown>)[sortObj.key!];
        const bv = (b as unknown as Record<string, unknown>)[sortObj.key!];
        const cmp = av instanceof Date && bv instanceof Date
          ? av.getTime() - bv.getTime()
          : String(av).localeCompare(String(bv));
        return (sortObj.dir ?? 1) < 0 ? -cmp : cmp;
      });
    }
    return matches[0] ?? null;
  }

  // ── Message mock ──────────────────────────────────────
  const Message = {
    create: vi.fn(async (doc: Partial<FakeMessage>) => {
      // Emulate unique externalMessageId index
      if (doc.externalMessageId && store.messages.some((m) => m.externalMessageId === doc.externalMessageId)) {
        const err = Object.assign(new Error('E11000 duplicate key'), { code: 11000, name: 'MongoServerError' });
        throw err;
      }
      const rec: FakeMessage = {
        _id: new Types.ObjectId(),
        conversationId: doc.conversationId!,
        channelId: doc.channelId!,
        channelRole: doc.channelRole!,
        accountDisplayName: doc.accountDisplayName!,
        direction: doc.direction!,
        contentType: doc.contentType ?? 'text',
        body: doc.body,
        externalMessageId: doc.externalMessageId,
        providerSessionId: doc.providerSessionId,
        deliveryStatus: doc.deliveryStatus ?? 'pending',
        rawPayload: doc.rawPayload,
        createdAt: new Date(),
      };
      store.messages.push(rec);
      return rec;
    }),
    findOne: vi.fn((filter: Record<string, unknown>) => {
      const finder = () => store.messages.find((m) => {
        if (filter['externalMessageId'] && m.externalMessageId !== filter['externalMessageId']) return false;
        return true;
      }) ?? null;
      return {
        select: () => ({
          lean: () => ({ exec: async () => finder() }),
          exec: async () => finder(),
        }),
        lean: () => ({ exec: async () => finder() }),
        exec: async () => finder(),
      };
    }),
    updateOne: vi.fn((filter: Record<string, unknown>, update: Record<string, unknown>) => ({
      exec: async () => {
        const msg = store.messages.find((m) => {
          if (filter['externalMessageId'] && m.externalMessageId !== filter['externalMessageId']) return false;
          if (filter['direction'] && m.direction !== filter['direction']) return false;
          return true;
        });
        if (msg) Object.assign(msg, (update['$set'] ?? {}) as Record<string, unknown>);
        return { matchedCount: msg ? 1 : 0 };
      },
    })),
    find: vi.fn(() => ({
      sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => store.messages }) }) }),
    })),
  };

  return { Channel, Conversation, Message, AIRequest: {}, InternalCandidate: {}, ExternalCandidate: {}, MatchSuggestion: {}, Task: {}, Note: {}, AuditLog: {}, User: {} };
});

// Reset store between tests (after mocks are defined so vi.mock hoists correctly)
beforeEach(() => {
  resetStore();
});

// ── Import after mocks are registered ────────────────────
// Lazy-resolved in beforeAll so vi.mock hoisting + ESM interop cooperate.

type ChannelManager = typeof import('./channel.manager.js');
type MessageHandler = typeof import('./message.handler.js');
type ConversationLinker = typeof import('./conversation.linker.js');

let connectChannel: ChannelManager['connectChannel'];
let replaceChannel: ChannelManager['replaceChannel'];
let disconnectChannel: ChannelManager['disconnectChannel'];
let findChannelByPhoneNumberId: ChannelManager['findChannelByPhoneNumberId'];
let handleInboundMessage: MessageHandler['handleInboundMessage'];
let handleStatusUpdate: MessageHandler['handleStatusUpdate'];
let findOrCreateConversation: ConversationLinker['findOrCreateConversation'];

beforeAll(async () => {
  const cm = await import('./channel.manager.js');
  const mh = await import('./message.handler.js');
  const cl = await import('./conversation.linker.js');
  connectChannel = cm.connectChannel;
  replaceChannel = cm.replaceChannel;
  disconnectChannel = cm.disconnectChannel;
  findChannelByPhoneNumberId = cm.findChannelByPhoneNumberId;
  handleInboundMessage = mh.handleInboundMessage;
  handleStatusUpdate = mh.handleStatusUpdate;
  findOrCreateConversation = cl.findOrCreateConversation;
});

function buildInboundMsg(overrides: Record<string, unknown> = {}): Parameters<MessageHandler['handleInboundMessage']>[0] {
  return {
    externalMessageId: 'wamid.test1',
    direction: 'inbound',
    providerSessionId: 'PHN_1',
    businessPhoneNumber: '+972501234567',
    participantPhone: '972509999999',
    participantName: 'Sarah',
    timestamp: new Date('2026-04-13T12:00:00Z'),
    contentType: 'text',
    body: 'shalom',
    rawPayload: { id: 'wamid.test1' },
    ...overrides,
  } as Parameters<MessageHandler['handleInboundMessage']>[0];
}

// ══════════════════════════════════════════════════════════
// Channel lifecycle
// ══════════════════════════════════════════════════════════

describe('Channel lifecycle', () => {
  it('connect creates an active channel with correct role + display name', async () => {
    const ch = await connectChannel({
      channelRole: 'profiles_source',
      accountDisplayName: 'Profiles Intake',
      phoneNumber: '+972501234567',
      providerSessionId: 'PHN_1',
    });
    expect(ch.channelId).toMatch(/^ch_/);
    expect(ch.role).toBe('profiles_source');
    expect(ch.status).toBe('active');
    expect(ch.accountDisplayName).toBe('Profiles Intake');
  });

  it('disconnect marks channel as disconnected without affecting history', async () => {
    const ch = await connectChannel({
      channelRole: 'match_sending',
      accountDisplayName: 'Match Sender',
      phoneNumber: '+972502222222',
      providerSessionId: 'PHN_2',
    });
    // Ingest a message first
    await handleInboundMessage(buildInboundMsg({
      providerSessionId: 'PHN_2',
      externalMessageId: 'msg_before_disconnect',
    }));
    const messagesBefore = store.messages.length;

    const result = await disconnectChannel(ch.channelId);
    expect(result.status).toBe('disconnected');

    // History must still exist
    expect(store.messages.length).toBe(messagesBefore);
    expect(store.conversations.length).toBeGreaterThan(0);
  });

  it('replace creates a new channel and marks old as REPLACED, preserving history', async () => {
    const oldCh = await connectChannel({
      channelRole: 'match_sending',
      accountDisplayName: 'Old Sender',
      phoneNumber: '+972501111111',
      providerSessionId: 'PHN_OLD',
    });
    // Ingest on old
    await handleInboundMessage(buildInboundMsg({
      providerSessionId: 'PHN_OLD',
      externalMessageId: 'msg_on_old',
    }));
    const oldMessages = store.messages.length;
    const oldConversations = store.conversations.length;

    const { oldChannel, newChannel } = await replaceChannel({
      oldChannelId: oldCh.channelId,
      newChannel: {
        channelRole: 'match_sending',
        accountDisplayName: 'New Sender',
        phoneNumber: '+972502222222',
        providerSessionId: 'PHN_NEW',
      },
    });

    expect(oldChannel.status).toBe('replaced');
    expect(oldChannel.replacedByChannelId).toBe(newChannel.channelId);
    expect(newChannel.status).toBe('active');
    expect(newChannel.replacesChannelId).toBe(oldCh.channelId);

    // History untouched
    expect(store.messages.length).toBe(oldMessages);
    expect(store.conversations.length).toBe(oldConversations);
  });

  it('findChannelByPhoneNumberId routes by provider phone number id', async () => {
    await connectChannel({
      channelRole: 'profiles_source',
      accountDisplayName: 'Profiles',
      phoneNumber: '+1',
      providerSessionId: 'PHN_A',
    });
    await connectChannel({
      channelRole: 'match_sending',
      accountDisplayName: 'Matches',
      phoneNumber: '+2',
      providerSessionId: 'PHN_B',
    });

    const found = await findChannelByPhoneNumberId('PHN_B');
    expect(found?.role).toBe('match_sending');
    expect(found?.accountDisplayName).toBe('Matches');
  });
});

// ══════════════════════════════════════════════════════════
// Inbound message processing
// ══════════════════════════════════════════════════════════

describe('Inbound message processing', () => {
  async function setupChannel(role: 'profiles_source' | 'match_sending' = 'profiles_source') {
    return connectChannel({
      channelRole: role,
      accountDisplayName: role === 'profiles_source' ? 'Intake' : 'Sender',
      phoneNumber: '+972501234567',
      providerSessionId: 'PHN_1',
    });
  }

  it('creates a conversation and stores the message on first inbound', async () => {
    await setupChannel();
    const res = await handleInboundMessage(buildInboundMsg());
    expect(res.stored).toBe(true);
    expect(res.messageId).toBeDefined();
    expect(res.conversationId).toBeDefined();
    expect(store.messages).toHaveLength(1);
    expect(store.conversations).toHaveLength(1);
    expect(store.conversations[0]!.unreadCount).toBe(1);
    expect(store.conversations[0]!.needsAction).toBe(true);
  });

  it('deduplicates on repeated externalMessageId (pre-check path)', async () => {
    await setupChannel();
    const a = await handleInboundMessage(buildInboundMsg({ externalMessageId: 'dup1' }));
    const b = await handleInboundMessage(buildInboundMsg({ externalMessageId: 'dup1' }));
    expect(a.stored).toBe(true);
    expect(b.stored).toBe(false);
    expect(b.skipReason).toBe('duplicate');
    expect(b.messageId).toBe(a.messageId);
    expect(store.messages).toHaveLength(1);
  });

  it('deduplicates on race E11000 path', async () => {
    await setupChannel();
    // Simulate race: two concurrent handlers both pass the pre-check
    const { Message: MessageMock } = await import('../../models/index.js');
    // Force findOne to return null on the first call of the 2nd message,
    // so we proceed to Message.create and hit the unique-key emulation.
    const originalFindOne = MessageMock.findOne;
    let callCount = 0;
    (MessageMock as unknown as { findOne: typeof originalFindOne }).findOne = ((filter: Record<string, unknown>) => {
      callCount += 1;
      // First 2 calls return null (pre-checks for both); subsequent calls behave normally (race re-lookup)
      if (callCount <= 2) {
        return {
          select: () => ({ lean: () => ({ exec: async () => null }), exec: async () => null }),
          lean: () => ({ exec: async () => null }),
          exec: async () => null,
        };
      }
      return originalFindOne(filter);
    }) as typeof originalFindOne;

    const first = await handleInboundMessage(buildInboundMsg({ externalMessageId: 'race1' }));
    const second = await handleInboundMessage(buildInboundMsg({ externalMessageId: 'race1' }));

    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
    expect(second.skipReason).toBe('duplicate');
    expect(store.messages).toHaveLength(1);

    (MessageMock as unknown as { findOne: typeof originalFindOne }).findOne = originalFindOne;
  });

  it('routes by channelRole — unknown channel returns skip', async () => {
    // No channels configured at all
    const res = await handleInboundMessage(buildInboundMsg({
      providerSessionId: 'PHN_NOT_CONFIGURED',
      externalMessageId: 'orphan1',
    }));
    expect(res.stored).toBe(false);
    expect(res.skipReason).toBe('unknown_channel');
    expect(store.messages).toHaveLength(0);
    expect(store.conversations).toHaveLength(0);
  });

  it('assigns purpose based on channel role', async () => {
    await setupChannel('profiles_source');
    await handleInboundMessage(buildInboundMsg({
      externalMessageId: 'intake1',
      participantPhone: '111',
    }));
    expect(store.conversations[0]!.purpose).toBe('profile_intake');

    // New channel in different role
    resetStore();
    await setupChannel('match_sending');
    await handleInboundMessage(buildInboundMsg({
      externalMessageId: 'send1',
      participantPhone: '222',
    }));
    expect(store.conversations[0]!.purpose).toBe('match_proposal');
  });

  it('reuses the same conversation for the same (channel, participant)', async () => {
    await setupChannel();
    await handleInboundMessage(buildInboundMsg({ externalMessageId: 'a', participantPhone: '9725' }));
    await handleInboundMessage(buildInboundMsg({ externalMessageId: 'b', participantPhone: '9725' }));
    await handleInboundMessage(buildInboundMsg({ externalMessageId: 'c', participantPhone: '9725' }));
    expect(store.conversations).toHaveLength(1);
    expect(store.messages).toHaveLength(3);
    expect(store.conversations[0]!.unreadCount).toBe(3);
  });

  it('creates separate conversations for different participants on the same channel', async () => {
    await setupChannel();
    await handleInboundMessage(buildInboundMsg({ externalMessageId: 'a', participantPhone: '111' }));
    await handleInboundMessage(buildInboundMsg({ externalMessageId: 'b', participantPhone: '222' }));
    expect(store.conversations).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════
// Conversation continuity across account replacement
// ══════════════════════════════════════════════════════════

describe('Conversation continuity', () => {
  it('sets supersedesConversationId + replacedChannelOriginId on new channel', async () => {
    const oldCh = await connectChannel({
      channelRole: 'match_sending',
      accountDisplayName: 'Old',
      phoneNumber: '+1',
      providerSessionId: 'PHN_OLD',
    });
    // Old conversation exists
    await handleInboundMessage(buildInboundMsg({
      providerSessionId: 'PHN_OLD',
      externalMessageId: 'old1',
      participantPhone: '972509',
    }));
    const oldConv = store.conversations[0]!;

    // Replace the channel
    const { newChannel } = await replaceChannel({
      oldChannelId: oldCh.channelId,
      newChannel: {
        channelRole: 'match_sending',
        accountDisplayName: 'New',
        phoneNumber: '+2',
        providerSessionId: 'PHN_NEW',
      },
    });

    // New message on new channel from same participant
    await handleInboundMessage(buildInboundMsg({
      providerSessionId: 'PHN_NEW',
      externalMessageId: 'new1',
      participantPhone: '972509',
    }));

    // Old conv untouched
    expect(oldConv.archivedAt).toBeUndefined();

    // New conv has continuity pointers
    const newConv = store.conversations.find((c) => c.channelId === newChannel.channelId);
    expect(newConv).toBeDefined();
    expect(String(newConv!.supersedesConversationId)).toBe(String(oldConv._id));
    expect(newConv!.replacedChannelOriginId).toBe(oldCh.channelId);

    // History is NOT merged
    expect(store.messages.filter((m) => m.channelId === oldCh.channelId)).toHaveLength(1);
    expect(store.messages.filter((m) => m.channelId === newChannel.channelId)).toHaveLength(1);
  });

  it('does NOT set continuity when the channel is fresh (not a replacement)', async () => {
    await connectChannel({
      channelRole: 'match_sending',
      accountDisplayName: 'Fresh',
      phoneNumber: '+1',
      providerSessionId: 'PHN_FRESH',
    });
    await handleInboundMessage(buildInboundMsg({
      providerSessionId: 'PHN_FRESH',
      externalMessageId: 'f1',
    }));
    const conv = store.conversations[0]!;
    expect(conv.supersedesConversationId).toBeUndefined();
    expect(conv.replacedChannelOriginId).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════
// Status updates
// ══════════════════════════════════════════════════════════

describe('Outbound status updates', () => {
  it('updates deliveryStatus when the message exists', async () => {
    await connectChannel({
      channelRole: 'match_sending',
      accountDisplayName: 'S',
      phoneNumber: '+1',
      providerSessionId: 'PHN_1',
    });
    // Fake an outbound message already stored
    store.messages.push({
      _id: new Types.ObjectId(),
      conversationId: new Types.ObjectId(),
      channelId: 'ch_x',
      channelRole: 'match_sending',
      accountDisplayName: 'S',
      direction: 'outbound',
      contentType: 'text',
      externalMessageId: 'wamid.out1',
      deliveryStatus: 'sent',
      createdAt: new Date(),
    });

    const res = await handleStatusUpdate({
      externalMessageId: 'wamid.out1',
      status: 'delivered',
      timestamp: new Date(),
      providerSessionId: 'PHN_1',
      rawPayload: {},
    });
    expect(res.updated).toBe(true);
    const msg = store.messages.find((m) => m.externalMessageId === 'wamid.out1');
    expect(msg?.deliveryStatus).toBe('delivered');
    expect(msg?.deliveredAt).toBeInstanceOf(Date);
  });

  it('skips gracefully when the outbound message is unknown', async () => {
    const res = await handleStatusUpdate({
      externalMessageId: 'wamid.unknown',
      status: 'read',
      timestamp: new Date(),
      providerSessionId: 'PHN_1',
      rawPayload: {},
    });
    expect(res.updated).toBe(false);
    expect(res.skipReason).toBe('unknown_message');
  });
});

// ══════════════════════════════════════════════════════════
// findOrCreateConversation direct tests
// ══════════════════════════════════════════════════════════

describe('findOrCreateConversation', () => {
  it('returns the same conversation when called twice with identical inputs', async () => {
    const channel = await connectChannel({
      channelRole: 'profiles_source',
      accountDisplayName: 'I',
      phoneNumber: '+1',
      providerSessionId: 'P',
    });
    const a = await findOrCreateConversation({ channel, participantPhone: '999' });
    const b = await findOrCreateConversation({ channel, participantPhone: '999' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(String(a.conversation._id)).toBe(String(b.conversation._id));
  });
});
