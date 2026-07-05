// ═══════════════════════════════════════════════════════════
// ShadchanAI — Baileys Mapper
//
// Pure functions that convert Baileys' native message / status
// shapes into the provider-neutral NormalizedInboundMessage and
// NormalizedStatusUpdate. Handlers downstream never see raw
// Baileys types — this is the provider boundary.
//
// No side effects. No DB. Fully unit-testable.
// ═══════════════════════════════════════════════════════════

import {
  MessageDirection,
  MessageContentType,
  MessageDeliveryStatus,
} from '@shadchanai/shared';
import { normalizeMessageContent } from '@whiskeysockets/baileys';
import type { proto, WAMessageUpdate } from '@whiskeysockets/baileys';
import type { IChannel } from '../../../../models/index.js';
import type {
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
} from '../../whatsapp.types.js';
import { WHATSAPP_CONTENT_TYPE_MAP, WHATSAPP_LIMITS } from '../../whatsapp.constants.js';

// ── JID helpers ──────────────────────────────────────────

/**
 * Baileys JIDs look like "972509999999@s.whatsapp.net" (individual)
 * or "120...@g.us" (group). Extract the phone portion (digits only).
 * Groups don't have a phone — we return the bare jid-local part.
 */
export function jidToPhone(jid: string | undefined | null): string {
  if (!jid) return '';
  const local = jid.split('@')[0] ?? '';
  // Individual JIDs may include a resource suffix ("xxx:1")
  const sansResource = local.split(':')[0] ?? local;
  return sansResource;
}

/**
 * Like jidToPhone, but only for jids that actually carry a phone number
 * ("…@s.whatsapp.net" / legacy "…@c.us"). Group ids ("@g.us"), channels
 * ("@newsletter") and anonymous LIDs ("@lid") return '' — their numeric
 * part is not anyone's phone and must not be stored as one.
 */
export function jidToPhoneStrict(jid: string | undefined | null): string {
  if (!jid) return '';
  return /@(?:s\.whatsapp\.net|c\.us)$/.test(jid) ? jidToPhone(jid) : '';
}

// ── Inbound message normalization ────────────────────────

/**
 * Normalize a Baileys messages.upsert entry into our neutral shape.
 * Returns null when the entry is not a user-visible message (e.g.,
 * protocol messages, reactions-only, revoked stubs) or is missing
 * the fields we need (no id, no sender jid).
 *
 * Callers should skip `msg.key.fromMe === true` at the caller site.
 */
export function mapInboundMessage(
  msg: proto.IWebMessageInfo,
  channel: IChannel,
): NormalizedInboundMessage | null {
  const externalMessageId = msg.key?.id ?? undefined;
  const fromJid = msg.key?.remoteJid ?? undefined;
  if (!externalMessageId || !fromJid) return null;

  // Group messages: we keep the group jid as participantPhone for now
  // and the actual sender participant on participantName. The conversation
  // is keyed by (channel, fromJid) so groups and 1:1 stay separate.
  const isGroup = fromJid.endsWith('@g.us');
  // Real poster of the message. In groups that's key.participant — never the
  // group jid itself (a "120363…" id is not anyone's phone, so no fallback).
  // History-sync messages carry the sender on the TOP-LEVEL participant
  // field instead of key.participant. Under WhatsApp's LID privacy rollout
  // either may arrive as an anonymous "…@lid"; newer Baileys then carries
  // the real phone jid on key.participantPn (absent in 6.7.x typings,
  // hence the cast).
  const key = msg.key as (proto.IMessageKey & { participantPn?: string | null }) | null | undefined;
  const posterJid = isGroup
    ? (key?.participantPn ?? key?.participant ?? msg.participant ?? undefined)
    : fromJid;

  // Unwrap envelope wrappers (ephemeral / disappearing, view-once, edited,
  // documentWithCaption, deviceSent) so a normal text/media message nested
  // inside one is not mistaken for an unsupported type and silently dropped.
  const content = normalizeMessageContent(msg.message);
  const { contentType, body, media } = extractContent(content);
  if (!contentType) return null;

  const timestamp = parseTimestamp(msg.messageTimestamp);
  const participantName = msg.pushName ?? undefined;

  return {
    externalMessageId,
    direction: MessageDirection.INBOUND,
    providerSessionId: channel.providerSessionId ?? channel.channelId,
    businessPhoneNumber: channel.phoneNumber ?? '',
    participantPhone: jidToPhone(fromJid),
    participantName,
    // Real poster (in groups this differs from participantPhone=group id).
    // Empty when the sender's phone is genuinely unknown (LID-only sender,
    // channel/newsletter post) — better absent than a misleading id. For
    // LID-only senders the lid is surfaced so the events layer can resolve
    // the phone via group metadata.
    senderName: participantName,
    senderPhone: jidToPhoneStrict(posterJid) || undefined,
    senderLid: posterJid?.endsWith('@lid') ? posterJid : undefined,
    chatJid: fromJid,
    chatType: isGroup ? 'group' : 'private',
    timestamp,
    contentType: contentType as MessageContentType,
    body,
    media,
    replyToExternalId: content?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
    rawPayload: truncatePayload(msg as unknown as Record<string, unknown>),
  };
}

// ── Content extraction ───────────────────────────────────

interface ExtractedContent {
  contentType: string | null;
  body?: string;
  media?: NormalizedInboundMessage['media'];
}

export function extractContent(message: proto.IMessage | null | undefined): ExtractedContent {
  if (!message) return { contentType: null };

  if (message.conversation) {
    return {
      contentType: WHATSAPP_CONTENT_TYPE_MAP['conversation'] ?? 'text',
      body: truncateText(message.conversation),
    };
  }
  if (message.extendedTextMessage?.text) {
    return {
      contentType: WHATSAPP_CONTENT_TYPE_MAP['extendedTextMessage'] ?? 'text',
      body: truncateText(message.extendedTextMessage.text),
    };
  }
  if (message.imageMessage) {
    return {
      contentType: WHATSAPP_CONTENT_TYPE_MAP['imageMessage'] ?? 'image',
      body: message.imageMessage.caption ?? undefined,
      media: {
        mimeType: message.imageMessage.mimetype ?? undefined,
        caption: message.imageMessage.caption ?? undefined,
      },
    };
  }
  if (message.videoMessage) {
    return {
      contentType: WHATSAPP_CONTENT_TYPE_MAP['videoMessage'] ?? 'video',
      body: message.videoMessage.caption ?? undefined,
      media: {
        mimeType: message.videoMessage.mimetype ?? undefined,
        caption: message.videoMessage.caption ?? undefined,
      },
    };
  }
  if (message.audioMessage) {
    return {
      contentType: WHATSAPP_CONTENT_TYPE_MAP['audioMessage'] ?? 'audio',
      media: { mimeType: message.audioMessage.mimetype ?? undefined },
    };
  }
  if (message.documentMessage) {
    return {
      contentType: WHATSAPP_CONTENT_TYPE_MAP['documentMessage'] ?? 'document',
      body: message.documentMessage.caption ?? undefined,
      media: {
        mimeType: message.documentMessage.mimetype ?? undefined,
        caption: message.documentMessage.caption ?? undefined,
        filename: message.documentMessage.fileName ?? undefined,
      },
    };
  }
  if (message.stickerMessage) {
    return {
      contentType: WHATSAPP_CONTENT_TYPE_MAP['stickerMessage'] ?? 'sticker',
      media: { mimeType: message.stickerMessage.mimetype ?? undefined },
    };
  }
  if (message.locationMessage) {
    const { degreesLatitude: lat, degreesLongitude: lng, name, address } = message.locationMessage;
    return {
      contentType: WHATSAPP_CONTENT_TYPE_MAP['locationMessage'] ?? 'location',
      body: `location: ${lat ?? '?'},${lng ?? '?'}${name ? ` (${name})` : ''}${address ? ` — ${address}` : ''}`,
    };
  }

  // Unhandled types (reactions, protocolMessage, etc.) — return null to skip
  return { contentType: null };
}

// ── Status update normalization ──────────────────────────

/**
 * Map a Baileys messages.update entry → our NormalizedStatusUpdate.
 *
 * Baileys sends WAMessageStatus values (int enum). We translate them
 * to our string enum. Returns null for updates we don't care about
 * (e.g., in-memory-only updates without status).
 */
export function mapStatusUpdate(
  update: WAMessageUpdate,
  channel: IChannel,
): NormalizedStatusUpdate | null {
  const externalMessageId = update.key?.id ?? undefined;
  const statusInt = update.update?.status;
  if (!externalMessageId || statusInt === undefined || statusInt === null) return null;

  const status = mapStatusInt(statusInt);
  if (!status) return null;

  return {
    externalMessageId,
    status,
    timestamp: new Date(),
    providerSessionId: channel.providerSessionId ?? channel.channelId,
    rawPayload: truncatePayload(update as unknown as Record<string, unknown>),
  };
}

/**
 * Baileys WAMessageStatus enum values (per protobuf):
 *   0 = ERROR
 *   1 = PENDING
 *   2 = SERVER_ACK (≈ sent)
 *   3 = DELIVERY_ACK (≈ delivered)
 *   4 = READ
 *   5 = PLAYED
 */
function mapStatusInt(s: number): MessageDeliveryStatus | null {
  switch (s) {
    case 0: return MessageDeliveryStatus.FAILED;
    case 1: return MessageDeliveryStatus.PENDING;
    case 2: return MessageDeliveryStatus.SENT;
    case 3: return MessageDeliveryStatus.DELIVERED;
    case 4: return MessageDeliveryStatus.READ;
    case 5: return MessageDeliveryStatus.READ;
    default: return null;
  }
}

// ── Utilities ────────────────────────────────────────────

function parseTimestamp(raw: proto.IWebMessageInfo['messageTimestamp']): Date {
  if (raw === null || raw === undefined) return new Date();
  const seconds = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(seconds)) return new Date();
  return new Date(seconds * 1000);
}

function truncateText(s: string): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= WHATSAPP_LIMITS.MAX_BODY_BYTES) return s;
  return buf.subarray(0, WHATSAPP_LIMITS.MAX_BODY_BYTES).toString('utf8');
}

function truncatePayload(raw: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = JSON.stringify(raw);
    if (Buffer.byteLength(json, 'utf8') <= WHATSAPP_LIMITS.MAX_PAYLOAD_BYTES) return raw;
    return { _truncated: true, _preview: json.slice(0, 1024) };
  } catch {
    return { _unserializable: true };
  }
}
