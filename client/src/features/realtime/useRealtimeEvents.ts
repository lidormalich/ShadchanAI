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
    };
  }, [enabled, qc]);
}

function dispatch(evt: RealtimeEnvelope, qc: ReturnType<typeof useQueryClient>): void {
  // Every meaningful backend event affects the unified dashboard
  // queue in some way — so we always invalidate it. Cost is small
  // (one extra list query) and it keeps the operator's starting
  // surface honest without a polling fallback.
  qc.invalidateQueries({ queryKey: ['dashboard', 'queue'] });

  switch (evt.type) {
    case 'conversation.updated': {
      const p = evt.payload as { conversationId?: string };
      qc.invalidateQueries({ queryKey: ['conversations'] });
      if (p.conversationId) {
        qc.invalidateQueries({ queryKey: ['messages', p.conversationId] });
      }
      return;
    }
    case 'extraction.needs_review': {
      qc.invalidateQueries({ queryKey: ['extraction', 'review-queue'] });
      return;
    }
    case 'match.updated': {
      const p = evt.payload as { matchId?: string };
      qc.invalidateQueries({ queryKey: ['matches'] });
      if (p.matchId) {
        qc.invalidateQueries({ queryKey: ['match', p.matchId] });
        qc.invalidateQueries({ queryKey: ['match', p.matchId, 'send-preview'] });
      }
      return;
    }
    case 'channel.updated': {
      const p = evt.payload as { channelId?: string };
      qc.invalidateQueries({ queryKey: ['channels'] });
      if (p.channelId) {
        qc.invalidateQueries({ queryKey: ['channel', p.channelId] });
        qc.invalidateQueries({ queryKey: ['channel', p.channelId, 'session-status'] });
      }
      return;
    }
  }
}
