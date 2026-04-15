// ═══════════════════════════════════════════════════════════
// ShadchanAI — WhatsApp Service Types
//
// Normalized, provider-agnostic shapes.
//
// Handlers (message.handler, conversation.linker) operate
// ONLY on the normalized types below. Provider-specific raw
// shapes live in `providers/<provider>/mapper.ts` and never
// cross this boundary.
//
// Current provider: Baileys (session/socket model).
// ═══════════════════════════════════════════════════════════

import type { ChannelRole, MessageDirection, MessageContentType, MessageDeliveryStatus } from '@shadchanai/shared';

// ── Normalized internal shapes ───────────────────────────

export interface NormalizedInboundMessage {
  externalMessageId: string;
  direction: MessageDirection;
  /** Our internal session identifier — maps to Channel.providerSessionId.
   *  For Baileys, this is generated once per channel (typically === channelId).
   */
  providerSessionId: string;
  /** The business account's phone (if known — may be empty until pairing completes) */
  businessPhoneNumber: string;
  participantPhone: string;
  participantName?: string;
  timestamp: Date;
  contentType: MessageContentType;
  body?: string;
  media?: {
    mediaId?: string;
    mimeType?: string;
    caption?: string;
    filename?: string;
  };
  replyToExternalId?: string;
  /** Raw provider payload — stored with select:false for audit only */
  rawPayload: Record<string, unknown>;
}

export interface NormalizedStatusUpdate {
  externalMessageId: string;
  status: MessageDeliveryStatus;
  timestamp: Date;
  failureReason?: string;
  providerSessionId: string;
  rawPayload: Record<string, unknown>;
}

// ── Channel management shapes ────────────────────────────

export interface ConnectChannelInput {
  channelRole: ChannelRole;
  accountDisplayName: string;
  /** Empty until Baileys pairing completes; filled from authenticated JID */
  phoneNumber?: string;
  /** Optional internal session id override. If omitted, channelId is used. */
  providerSessionId?: string;
  /** Optional — provided when replacing an existing channel */
  replacesChannelId?: string;
}

export interface ReplaceChannelInput {
  oldChannelId: string;
  newChannel: Omit<ConnectChannelInput, 'replacesChannelId'>;
}

export interface ChannelHealthUpdate {
  channelId: string;
  connectionHealth: 'healthy' | 'degraded' | 'down';
  webhookStatus?: 'verified' | 'pending' | 'failed';
  lastHealthCheckAt?: Date;
}

// ── Baileys session status (reported to admins / UI) ─────

export type BaileysSessionState =
  | 'idle'             // session object created, not yet started
  | 'connecting'       // socket opening
  | 'pending_pairing'  // QR emitted, awaiting scan
  | 'connected'        // authenticated and online
  | 'reconnecting'     // transient disconnect, will retry
  | 'disconnected'     // intentional stop
  | 'logged_out';      // credentials invalidated, needs re-pair

export interface BaileysChannelStatus {
  channelId: string;
  state: BaileysSessionState;
  /** Current QR string (base64 / otpauth-like). Present only in 'pending_pairing'.
   *  NEVER persisted, NEVER logged, NEVER returned in list/summary endpoints. */
  qr?: string;
  lastError?: string;
  lastConnectedAt?: Date;
}

// ── Handler results (for idempotency signaling) ──────────

export interface MessageHandleResult {
  stored: boolean;
  /** If not stored, why: 'duplicate' | 'unknown_channel' | 'invalid_payload' */
  skipReason?: string;
  messageId?: string;
  conversationId?: string;
}
