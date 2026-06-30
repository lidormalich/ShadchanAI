// ═══════════════════════════════════════════════════════════
// ShadchanAI — WhatsApp Logger
//
// Structured, PII-conscious logging for WhatsApp operations.
// Never throws — logger failures never break message processing.
//
// Secrets / tokens are NEVER logged. Phone numbers are masked
// to last 4 digits in non-debug contexts.
// ═══════════════════════════════════════════════════════════

import { createLogger } from '../../utils/logger.js';

const log = createLogger('whatsapp');

export type WhatsAppLogEvent =
  | 'webhook_received'
  | 'webhook_signature_invalid'
  | 'webhook_payload_invalid'
  | 'message_persisted'
  | 'message_duplicate'
  | 'message_skipped_unsupported'
  | 'message_ignored_assigned_ignore'
  | 'message_ignored_assigned_match_sending'
  | 'message_ignored_unmapped_conversation'
  | 'message_accepted_for_ingestion'
  | 'status_updated'
  | 'conversation_linked'
  | 'conversation_created'
  | 'channel_connected'
  | 'channel_reconnected'
  | 'channel_disconnected'
  | 'channel_replaced'
  | 'channel_not_found'
  | 'error';

export interface WhatsAppLogFields {
  event: WhatsAppLogEvent;
  channelId?: string;
  channelRole?: string;
  accountDisplayName?: string;
  conversationId?: string;
  messageId?: string;
  externalMessageId?: string;
  participantPhoneMasked?: string;
  processedMessages?: number;
  processedStatuses?: number;
  skippedDuplicates?: number;
  errors?: number;
  latencyMs?: number;
  errorMessage?: string;
  [key: string]: unknown;
}

/** Mask a phone number to its last 4 digits (never log full numbers) */
export function maskPhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return `***${digits}`;
  return `***${digits.slice(-4)}`;
}

export function logWhatsApp(fields: WhatsAppLogFields): void {
  try {
    const level: 'error' | 'warn' | 'info' =
      fields.event === 'error' || fields.event === 'webhook_signature_invalid' ? 'error'
      : fields.event === 'message_duplicate' || fields.event === 'channel_not_found' ? 'warn'
      : 'info';
    log[level](fields, fields.event);
  } catch {
    // Never throw from logger
  }
}
