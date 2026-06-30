// ═══════════════════════════════════════════════════════════
// useRealtimeEvents — subscribes to GET /api/realtime/events
// (Server-Sent Events) and turns server-side events into
// targeted React Query cache invalidations.
//
// Mount once, high enough in the tree to cover every surface
// whose caches need live updates. Today it is mounted from
// ChatsPage; can be promoted to the AppShell if more surfaces
// require live awareness.
//
// SSE auth: browsers can't send an Authorization header on
// EventSource, so we append the token as a query param —
// the /api/realtime/events handler lives behind requireAuth
// which reads Authorization OR X-Dev-User; browsers will fall
// back to the cookie-less dev header via the query string
// bridge the client attaches in buildUrl().
// ═══════════════════════════════════════════════════════════

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

interface RealtimeEnvelope<T = unknown> {
  type: 'conversation.updated' | 'extraction.needs_review' | 'match.updated' | 'channel.updated';
  at: string;
  payload: T;
}

// SSE bursts during busy periods would otherwise fire an invalidation
// per event (each at least the dashboard queue). To avoid cache thrash
// we buffer the distinct query keys touched within a window and flush a
// single invalidation pass per distinct key once the window settles.
//
// Keys are serialized to JSON so the Set dedupes structurally; the
// original arrays are recovered with JSON.parse at flush time.
const INVALIDATE_DEBOUNCE_MS = 1500;
const pendingKeys = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function enqueue(qc: ReturnType<typeof useQueryClient>, queryKey: readonly unknown[]): void {
  pendingKeys.add(JSON.stringify(queryKey));
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const keys = [...pendingKeys];
    pendingKeys.clear();
    for (const serialized of keys) {
      qc.invalidateQueries({ queryKey: JSON.parse(serialized) as unknown[] });
    }
  }, INVALIDATE_DEBOUNCE_MS);
}

export function useRealtimeEvents(enabled = true): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const token = localStorage.getItem('auth_token');
    const devUser = localStorage.getItem('dev_user');
    // EventSource can't set custom headers, so pass auth as a query
    // param. Backend accepts either header OR query via a small
    // shim (header path untouched for non-SSE consumers).
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    else if (devUser) params.set('dev_user', devUser);
    const url = `/api/realtime/events${params.toString() ? `?${params}` : ''}`;

    let es: EventSource | null = null;
    try {
      es = new EventSource(url, { withCredentials: false });
    } catch {
      return; // Browser without SSE support — silently no-op.
    }

    const handle = (raw: MessageEvent): void => {
      let evt: RealtimeEnvelope;
      try { evt = JSON.parse(raw.data); } catch { return; }
      dispatch(evt, qc);
    };

    es.addEventListener('conversation.updated', handle);
    es.addEventListener('extraction.needs_review', handle);
    es.addEventListener('match.updated', handle);
    es.addEventListener('channel.updated', handle);

    return () => {
      es?.removeEventListener('conversation.updated', handle);
      es?.removeEventListener('extraction.needs_review', handle);
      es?.removeEventListener('match.updated', handle);
      es?.removeEventListener('channel.updated', handle);
      es?.close();
      // Cancel any pending flush so no invalidation fires after the
      // EventSource is closed and the component is gone.
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingKeys.clear();
    };
  }, [enabled, qc]);
}

function dispatch(evt: RealtimeEnvelope, qc: ReturnType<typeof useQueryClient>): void {
  // Every meaningful backend event affects the unified dashboard
  // queue in some way — so we always invalidate it. Cost is small
  // (one extra list query) and it keeps the operator's starting
  // surface honest without a polling fallback.
  //
  // Invalidations are buffered + debounced (see enqueue) so bursts of
  // events collapse into one invalidation per distinct key.
  enqueue(qc, ['dashboard', 'queue']);

  switch (evt.type) {
    case 'conversation.updated': {
      const p = evt.payload as { conversationId?: string };
      enqueue(qc, ['conversations']);
      if (p.conversationId) {
        enqueue(qc, ['messages', p.conversationId]);
      }
      return;
    }
    case 'extraction.needs_review': {
      enqueue(qc, ['extraction', 'review-queue']);
      return;
    }
    case 'match.updated': {
      const p = evt.payload as { matchId?: string };
      enqueue(qc, ['matches']);
      if (p.matchId) {
        enqueue(qc, ['match', p.matchId]);
        enqueue(qc, ['match', p.matchId, 'send-preview']);
      }
      return;
    }
    case 'channel.updated': {
      const p = evt.payload as { channelId?: string };
      enqueue(qc, ['channels']);
      if (p.channelId) {
        enqueue(qc, ['channel', p.channelId]);
        enqueue(qc, ['channel', p.channelId, 'session-status']);
      }
      return;
    }
  }
}
