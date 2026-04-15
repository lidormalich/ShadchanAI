// ═══════════════════════════════════════════════════════════
// Baileys Mapper Tests
//
// Replaces the retired Meta webhook validator tests.
// These verify the provider boundary: any Baileys-shaped input
// must produce a correct, provider-neutral NormalizedInboundMessage
// (or null, for messages we intentionally ignore).
//
// Pure function — no DB, no mocks, no network.
// ═══════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import type { proto, WAMessageUpdate } from '@whiskeysockets/baileys';
import type { IChannel } from '../../../../models/index.js';
import {
  mapInboundMessage,
  mapStatusUpdate,
  extractContent,
  jidToPhone,
} from './baileys.mapper.js';

const channel = {
  channelId: 'ch_test',
  providerSessionId: 'ch_test',
  phoneNumber: '+972501234567',
  role: 'profiles_source',
  accountDisplayName: 'Profiles Intake',
} as unknown as IChannel;

function baseMessage(overrides: Partial<proto.IWebMessageInfo> = {}): proto.IWebMessageInfo {
  return {
    key: {
      id: 'wamid.abc',
      remoteJid: '972509999999@s.whatsapp.net',
      fromMe: false,
    },
    messageTimestamp: 1713100000,
    pushName: 'Sarah',
    message: { conversation: 'Shalom' },
    ...overrides,
  } as proto.IWebMessageInfo;
}

// ══════════════════════════════════════════════════════════
// jidToPhone
// ══════════════════════════════════════════════════════════

describe('jidToPhone', () => {
  it('extracts phone from individual JID', () => {
    expect(jidToPhone('972509999999@s.whatsapp.net')).toBe('972509999999');
  });
  it('strips :resource suffixes', () => {
    expect(jidToPhone('972509999999:48@s.whatsapp.net')).toBe('972509999999');
  });
  it('returns empty for undefined/null/empty', () => {
    expect(jidToPhone(undefined)).toBe('');
    expect(jidToPhone(null)).toBe('');
    expect(jidToPhone('')).toBe('');
  });
});

// ══════════════════════════════════════════════════════════
// extractContent
// ══════════════════════════════════════════════════════════

describe('extractContent', () => {
  it('extracts plain text from conversation', () => {
    const r = extractContent({ conversation: 'Shalom' } as proto.IMessage);
    expect(r.contentType).toBe('text');
    expect(r.body).toBe('Shalom');
  });

  it('extracts extended text', () => {
    const r = extractContent({ extendedTextMessage: { text: 'Hello' } } as proto.IMessage);
    expect(r.contentType).toBe('text');
    expect(r.body).toBe('Hello');
  });

  it('extracts image with caption into body + media', () => {
    const r = extractContent({
      imageMessage: { mimetype: 'image/jpeg', caption: 'profile photo' },
    } as proto.IMessage);
    expect(r.contentType).toBe('image');
    expect(r.body).toBe('profile photo');
    expect(r.media?.mimeType).toBe('image/jpeg');
  });

  it('extracts document with filename', () => {
    const r = extractContent({
      documentMessage: { mimetype: 'application/pdf', fileName: 'cv.pdf' },
    } as proto.IMessage);
    expect(r.contentType).toBe('document');
    expect(r.media?.filename).toBe('cv.pdf');
  });

  it('returns null contentType for unsupported message types', () => {
    const r = extractContent({ reactionMessage: {} } as proto.IMessage);
    expect(r.contentType).toBeNull();
  });

  it('returns null contentType for null/empty message', () => {
    expect(extractContent(null).contentType).toBeNull();
    expect(extractContent(undefined).contentType).toBeNull();
    expect(extractContent({} as proto.IMessage).contentType).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════
// mapInboundMessage
// ══════════════════════════════════════════════════════════

describe('mapInboundMessage', () => {
  it('maps a text conversation message', () => {
    const out = mapInboundMessage(baseMessage(), channel);
    expect(out).not.toBeNull();
    expect(out!.externalMessageId).toBe('wamid.abc');
    expect(out!.direction).toBe('inbound');
    expect(out!.providerSessionId).toBe('ch_test');
    expect(out!.businessPhoneNumber).toBe('+972501234567');
    expect(out!.participantPhone).toBe('972509999999');
    expect(out!.participantName).toBe('Sarah');
    expect(out!.body).toBe('Shalom');
    expect(out!.contentType).toBe('text');
    expect(out!.timestamp.getTime()).toBe(1713100000 * 1000);
  });

  it('returns null when id is missing', () => {
    const out = mapInboundMessage(baseMessage({ key: { remoteJid: '972@s.whatsapp.net', fromMe: false } }), channel);
    expect(out).toBeNull();
  });

  it('returns null when remoteJid is missing', () => {
    const out = mapInboundMessage(baseMessage({ key: { id: 'x', fromMe: false } }), channel);
    expect(out).toBeNull();
  });

  it('returns null for protocol/unsupported message types (e.g., reactions)', () => {
    const out = mapInboundMessage(baseMessage({ message: { reactionMessage: {} } as proto.IMessage }), channel);
    expect(out).toBeNull();
  });

  it('treats group messages: participantPhone comes from the group JID scope', () => {
    const out = mapInboundMessage(
      baseMessage({
        key: { id: 'wamid.g', remoteJid: '120000000000@g.us', participant: '972509999999@s.whatsapp.net', fromMe: false },
      }),
      channel,
    );
    expect(out).not.toBeNull();
    expect(out!.participantPhone).toBe('120000000000');
  });

  it('carries reply context via replyToExternalId', () => {
    const out = mapInboundMessage(
      baseMessage({
        message: {
          extendedTextMessage: {
            text: 'reply',
            contextInfo: { stanzaId: 'wamid.parent' },
          },
        } as proto.IMessage,
      }),
      channel,
    );
    expect(out!.replyToExternalId).toBe('wamid.parent');
  });

  it('uses providerSessionId from channel, falling back to channelId', () => {
    const channelNoSession = { ...channel, providerSessionId: undefined } as unknown as IChannel;
    const out = mapInboundMessage(baseMessage(), channelNoSession);
    expect(out!.providerSessionId).toBe('ch_test'); // channelId
  });
});

// ══════════════════════════════════════════════════════════
// mapStatusUpdate
// ══════════════════════════════════════════════════════════

describe('mapStatusUpdate', () => {
  it('maps delivered (int 3) → delivered', () => {
    const r = mapStatusUpdate({
      key: { id: 'wamid.out1', fromMe: true },
      update: { status: 3 },
    } as WAMessageUpdate, channel);
    expect(r).not.toBeNull();
    expect(r!.status).toBe('delivered');
    expect(r!.externalMessageId).toBe('wamid.out1');
  });

  it('maps read (int 4) → read', () => {
    const r = mapStatusUpdate({
      key: { id: 'wamid.out2', fromMe: true },
      update: { status: 4 },
    } as WAMessageUpdate, channel);
    expect(r!.status).toBe('read');
  });

  it('maps played (int 5) → read (we don\u2019t separate the two)', () => {
    const r = mapStatusUpdate({
      key: { id: 'wamid.out3', fromMe: true },
      update: { status: 5 },
    } as WAMessageUpdate, channel);
    expect(r!.status).toBe('read');
  });

  it('maps error (int 0) → failed', () => {
    const r = mapStatusUpdate({
      key: { id: 'wamid.outbad', fromMe: true },
      update: { status: 0 },
    } as WAMessageUpdate, channel);
    expect(r!.status).toBe('failed');
  });

  it('returns null when status is missing', () => {
    const r = mapStatusUpdate({
      key: { id: 'x', fromMe: true },
      update: {},
    } as WAMessageUpdate, channel);
    expect(r).toBeNull();
  });

  it('returns null when id is missing', () => {
    const r = mapStatusUpdate({
      key: { fromMe: true },
      update: { status: 3 },
    } as WAMessageUpdate, channel);
    expect(r).toBeNull();
  });
});
