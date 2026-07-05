// ═══════════════════════════════════════════════════════════
// LID Resolver Tests
//
// Verifies lid→phone translation via group metadata, per-group
// caching, graceful failure, and the stored-row repair pass.
// Models are mocked — no real MongoDB.
// ═══════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GroupMetadata } from '@whiskeysockets/baileys';
import type { IChannel } from '../../models/index.js';

// ── Model mocks ──────────────────────────────────────────

interface FakeMessageRow {
  _id: string;
  chatJid: string;
  senderPhone?: string;
  rawPayload?: Record<string, unknown>;
}
interface FakeCandidateRow {
  _id: string;
  sourceChatJid: string;
  sourceSenderPhone?: string;
  sourceMessageIds: string[];
}

let fakeMessages: FakeMessageRow[] = [];
let fakeCandidates: FakeCandidateRow[] = [];

function chain<T>(result: T): { select: () => unknown; sort: () => unknown; lean: () => unknown; exec: () => Promise<T> } {
  const c = {
    select: () => c,
    sort: () => c,
    lean: () => c,
    exec: async () => result,
  };
  return c;
}

vi.mock('../../models/index.js', () => ({
  Message: {
    find: vi.fn((q: { chatJid: string }) =>
      chain(fakeMessages.filter((m) => m.chatJid === q.chatJid && m.senderPhone === undefined))),
    findOne: vi.fn((q: { _id: { $in: string[] } }) =>
      chain(
        fakeMessages.find((m) => q._id.$in.includes(m._id) && m.senderPhone) ?? null,
      )),
    updateOne: vi.fn((q: { _id: string }, u: { $set: { senderPhone: string } }) => ({
      exec: async () => {
        const row = fakeMessages.find((m) => m._id === q._id);
        if (row) row.senderPhone = u.$set.senderPhone;
        return { modifiedCount: 1 };
      },
    })),
  },
  ExternalCandidate: {
    find: vi.fn((q: { sourceChatJid: string }) =>
      chain(fakeCandidates.filter(
        (c) => c.sourceChatJid === q.sourceChatJid && c.sourceSenderPhone === undefined,
      ))),
    updateOne: vi.fn((q: { _id: string }, u: { $set: { sourceSenderPhone: string } }) => ({
      exec: async () => {
        const row = fakeCandidates.find((c) => c._id === q._id);
        if (row) row.sourceSenderPhone = u.$set.sourceSenderPhone;
        return { modifiedCount: 1 };
      },
    })),
  },
}));

import { resolveLidToPhone, repairStoredLidRows, _resetLidResolver } from './lid-resolver.js';

const channel = {
  channelId: 'ch_test',
  role: 'profiles_source',
} as unknown as IChannel;

const GROUP = '120363026849238095@g.us';

function metadataWith(participants: Array<{ id: string; lid?: string; jid?: string }>): GroupMetadata {
  return { id: GROUP, participants } as unknown as GroupMetadata;
}

function fakeSock(meta: GroupMetadata): { groupMetadata: ReturnType<typeof vi.fn> } {
  return { groupMetadata: vi.fn(async () => meta) };
}

beforeEach(() => {
  _resetLidResolver();
  fakeMessages = [];
  fakeCandidates = [];
});

describe('resolveLidToPhone', () => {
  it('translates a lid participant to their phone via metadata', async () => {
    const sock = fakeSock(metadataWith([
      { id: '268895067836596@lid', jid: '972501112233@s.whatsapp.net' },
    ]));
    const phone = await resolveLidToPhone(sock, channel, GROUP, '268895067836596@lid');
    expect(phone).toBe('972501112233');
  });

  it('supports pn-addressed groups where lid rides on the .lid field', async () => {
    const sock = fakeSock(metadataWith([
      { id: '972501112233@s.whatsapp.net', lid: '268895067836596@lid' },
    ]));
    const phone = await resolveLidToPhone(sock, channel, GROUP, '268895067836596@lid');
    expect(phone).toBe('972501112233');
  });

  it('caches metadata per group — one fetch for repeated hits', async () => {
    const sock = fakeSock(metadataWith([
      { id: '268895067836596@lid', jid: '972501112233@s.whatsapp.net' },
    ]));
    await resolveLidToPhone(sock, channel, GROUP, '268895067836596@lid');
    await resolveLidToPhone(sock, channel, GROUP, '268895067836596@lid');
    expect(sock.groupMetadata).toHaveBeenCalledTimes(1);
  });

  it('returns empty when the lid has no shared phone', async () => {
    const sock = fakeSock(metadataWith([
      { id: '268895067836596@lid' }, // privacy: no jid shared
    ]));
    const phone = await resolveLidToPhone(sock, channel, GROUP, '268895067836596@lid');
    expect(phone).toBe('');
  });

  it('returns empty (not throw) when groupMetadata fails', async () => {
    const sock = { groupMetadata: vi.fn(async () => { throw new Error('boom'); }) };
    const phone = await resolveLidToPhone(sock, channel, GROUP, '268895067836596@lid');
    expect(phone).toBe('');
  });

  it('ignores non-lid or non-group input', async () => {
    const sock = fakeSock(metadataWith([]));
    expect(await resolveLidToPhone(sock, channel, GROUP, '972501112233@s.whatsapp.net')).toBe('');
    expect(await resolveLidToPhone(sock, channel, 'x@newsletter', '1@lid')).toBe('');
    expect(sock.groupMetadata).not.toHaveBeenCalled();
  });
});

describe('repairStoredLidRows', () => {
  it('backfills messages from rawPayload lid and re-derives candidates', async () => {
    fakeMessages = [
      {
        _id: 'm1',
        chatJid: GROUP,
        rawPayload: { key: { remoteJid: GROUP }, participant: '268895067836596@lid' },
      },
      {
        _id: 'm2',
        chatJid: GROUP,
        rawPayload: { key: { remoteJid: GROUP, participant: '999999999999999@lid' } },
      },
    ];
    fakeCandidates = [
      { _id: 'c1', sourceChatJid: GROUP, sourceMessageIds: ['m1'] },
      { _id: 'c2', sourceChatJid: GROUP, sourceMessageIds: ['m2'] },
    ];

    await repairStoredLidRows(channel, GROUP, new Map([
      ['268895067836596', '972501112233'],
    ]));

    expect(fakeMessages[0]!.senderPhone).toBe('972501112233');
    expect(fakeMessages[1]!.senderPhone).toBeUndefined(); // unresolvable lid stays empty
    expect(fakeCandidates[0]!.sourceSenderPhone).toBe('972501112233');
    expect(fakeCandidates[1]!.sourceSenderPhone).toBeUndefined();
  });
});
