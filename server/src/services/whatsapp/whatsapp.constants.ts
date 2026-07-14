// ═══════════════════════════════════════════════════════════
// ShadchanAI — WhatsApp Constants (provider-neutral)
// ═══════════════════════════════════════════════════════════

export const WHATSAPP_LIMITS = {
  /** Max raw payload bytes we'll store (truncate larger) */
  MAX_PAYLOAD_BYTES: 64_000,

  /** Max body text bytes we'll index */
  MAX_BODY_BYTES: 16_000,
} as const;

/** Maps provider-native message types → our shared MessageContentType values. */
export const WHATSAPP_CONTENT_TYPE_MAP: Record<string, string> = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  locationMessage: 'location',
  liveLocationMessage: 'location',
  contactMessage: 'contact',
  contactsArrayMessage: 'contact',
  stickerMessage: 'sticker',
  templateMessage: 'template',
  buttonsMessage: 'interactive',
  listMessage: 'interactive',
  interactiveMessage: 'interactive',
};

export const BAILEYS = {
  /** File permissions for session directory contents. */
  SESSION_FILE_MODE: 0o600,

  /** Initial reconnect backoff (ms). */
  RECONNECT_BACKOFF_MS: 2_000,

  /** Max reconnect backoff (ms). */
  RECONNECT_MAX_BACKOFF_MS: 60_000,

  /** How long to hold a QR before abandoning the pairing attempt (ms). */
  QR_EXPIRY_MS: 60_000,

  /** How many older messages to request per on-demand history sync. */
  HISTORY_FETCH_COUNT: 50,
} as const;

/** Post-reconnect downtime coverage report (coverage.service). */
export const COVERAGE = {
  /** Offline windows shorter than this are routine churn — no report. */
  MIN_GAP_MS: 10 * 60_000,

  /** How long after reconnect to wait before counting, so WhatsApp's
   *  offline queue has time to flush through ingestion. */
  SETTLE_MS: 5 * 60_000,

  /** Baseline period (before the window) used to estimate a chat's
   *  normal traffic rate. */
  BASELINE_DAYS: 7,

  /** A zero-message chat is only suspect if its baseline rate predicts
   *  at least this many messages inside the window. */
  SUSPECT_MIN_EXPECTED: 1,
} as const;
