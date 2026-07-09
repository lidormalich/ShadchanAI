// ═══════════════════════════════════════════════════════════
// Notifications feed (Phase 5).
//
// Deliberately lightweight: an in-memory ring buffer of the most
// recent operational events for the single Node.js instance this
// app runs as today. Matches the existing Baileys single-instance
// assumption — when we scale horizontally, swap the ring for a
// persisted collection with the same shape.
//
// The feed is populated by subscribing to the same realtime
// broker (services/realtime/realtime.service) that the SSE
// endpoint already uses, so there is exactly ONE source of truth
// for the stream, and no duplicated emit sites.
// ═══════════════════════════════════════════════════════════

import {
  subscribeRealtime,
  type RealtimeEvent,
  type RealtimeEventType,
} from '../realtime/realtime.service.js';

const MAX_FEED = 100;

export interface NotificationItem {
  id: string;              // unique per event (timestamp + type + id hash)
  type: RealtimeEventType;
  at: string;
  title: string;
  payload: Record<string, unknown>;
}

const feed: NotificationItem[] = [];
let started = false;

// Hebrew labels for match transition/status values that may tail a
// notification title (shown verbatim in the notifications bell).
const MATCH_TRANSITION_HE: Record<string, string> = {
  draft: 'טיוטה',
  pending_approval: 'ממתינה לאישור',
  approved: 'אושרה',
  sent: 'נשלחה',
  response_acknowledged: 'התקבלה תגובה',
  accepted: 'התקבלה',
  accepted_both: 'אושרה ע״י שני הצדדים',
  declined: 'נדחתה',
  deferred: 'הושהתה',
  dating: 'עברה להיכרות',
  expired: 'פגה תוקף',
  closed: 'נסגרה',
};

function toNotification(evt: RealtimeEvent): NotificationItem {
  const p = (evt.payload as Record<string, unknown>) ?? {};
  const key =
    (p['messageId'] as string | undefined) ??
    (p['matchId'] as string | undefined) ??
    (p['conversationId'] as string | undefined) ??
    Math.random().toString(36).slice(2);

  let title = '';
  switch (evt.type) {
    case 'conversation.updated':
      title = (p['direction'] === 'inbound')
        ? 'הודעה חדשה בשיחה'
        : 'עדכון שיחה';
      break;
    case 'extraction.needs_review':
      title = 'פרופיל חדש ממתין לסקירה';
      break;
    case 'match.updated':
      title = (p['transition'] === 'sent')
        ? 'הצעה נשלחה'
        : (p['transition'] === 'response_acknowledged')
          ? 'תגובה אושרה'
          : `הצעה: ${MATCH_TRANSITION_HE[String(p['transition'] ?? p['status'])] ?? (p['transition'] ?? p['status'])}`;
      break;
  }
  return {
    id: `${new Date(evt.at).getTime()}:${evt.type}:${key}`,
    type: evt.type,
    at: evt.at,
    title,
    payload: p,
  };
}

/**
 * Start subscribing once on first use. Safe to call multiple times.
 */
export function ensureNotificationsStarted(): void {
  if (started) return;
  started = true;
  subscribeRealtime((evt) => {
    feed.unshift(toNotification(evt));
    if (feed.length > MAX_FEED) feed.length = MAX_FEED;
  });
}

export function getRecentNotifications(limit = 30): NotificationItem[] {
  ensureNotificationsStarted();
  return feed.slice(0, limit);
}
