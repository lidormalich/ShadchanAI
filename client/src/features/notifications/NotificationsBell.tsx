// ═══════════════════════════════════════════════════════════
// Notifications bell (Phase 5).
//
// Minimal, honest: the recent events feed (in-memory on the
// server). Unread-count is local to the browser — we persist
// the last-seen timestamp in localStorage so a refresh doesn't
// reset the badge. Clicking an item navigates to the relevant
// surface. Not a full notifications center.
// ═══════════════════════════════════════════════════════════

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconButton } from '@/components/ui/primitives';
import { notificationsApi, type NotificationItem } from '@/services/api/notifications';

const LAST_SEEN_KEY = 'notifications_last_seen_at';

function loadLastSeen(): number {
  const raw = localStorage.getItem(LAST_SEEN_KEY);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}
function saveLastSeen(ms: number): void {
  localStorage.setItem(LAST_SEEN_KEY, String(ms));
}

function routeFor(n: NotificationItem): string | null {
  const p = n.payload;
  if (n.type === 'conversation.updated' && typeof p['conversationId'] === 'string') {
    return `/chats?conversation=${p['conversationId']}`;
  }
  if (n.type === 'extraction.needs_review' && typeof p['messageId'] === 'string') {
    return `/review?messageId=${p['messageId']}`;
  }
  if (n.type === 'match.updated' && typeof p['matchId'] === 'string') {
    return `/matches/${p['matchId']}`;
  }
  return null;
}

export function NotificationsBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [lastSeenMs, setLastSeenMs] = useState<number>(loadLastSeen);
  const wrapRef = useRef<HTMLDivElement>(null);

  const q = useQuery({
    queryKey: ['notifications', 'recent'],
    queryFn: () => notificationsApi.list(30),
    refetchInterval: open ? 30_000 : false,
    staleTime: 10_000,
  });

  // Realtime events (Phase 3) invalidate meaningful caches; we
  // refetch notifications whenever the dashboard queue does.
  useEffect(() => {
    const unsub = qc.getQueryCache().subscribe((e) => {
      // When anything under ['dashboard','queue'] or ['conversations']
      // changes, a new operational event likely fired. Refresh feed.
      if (e.type === 'updated' && Array.isArray(e.query.queryKey)) {
        const [head, sub] = e.query.queryKey as [string, string?];
        if (head === 'dashboard' && sub === 'queue') {
          q.refetch();
        }
      }
    });
    return unsub;
  }, [qc, q]);

  // Close on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const items = q.data?.data ?? [];
  const unread = items.filter((n) => new Date(n.at).getTime() > lastSeenMs).length;

  const openPanel = (): void => {
    setOpen((prev) => {
      const next = !prev;
      if (next && items.length > 0) {
        const newest = new Date(items[0]!.at).getTime();
        saveLastSeen(newest);
        setLastSeenMs(newest);
      }
      return next;
    });
  };

  const clickItem = (n: NotificationItem): void => {
    const to = routeFor(n);
    setOpen(false);
    if (to) navigate(to);
  };

  return (
    <div ref={wrapRef} className="relative">
      <IconButton aria-label="notifications" onClick={openPanel}>
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -end-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-danger text-white text-[10px] font-semibold inline-flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </IconButton>

      {open && (
        <div className="absolute end-0 top-11 w-80 max-w-[calc(100vw-1rem)] bg-white border border-border rounded-lg shadow-rise z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <span className="text-sm font-semibold">התראות</span>
            <span className="text-[11px] text-ink-faint">{items.length} אחרונות</span>
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {q.isLoading ? (
              <li className="p-3 text-xs text-ink-muted">טוען…</li>
            ) : items.length === 0 ? (
              <li className="p-3 text-xs text-ink-muted">אין התראות כרגע</li>
            ) : (
              items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => clickItem(n)}
                    className="w-full text-start px-3 py-2 hover:bg-bg-hover"
                  >
                    <div className="text-sm">{n.title}</div>
                    <div className="text-[11px] text-ink-faint mt-0.5">
                      {new Date(n.at).toLocaleString('he-IL')}
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
