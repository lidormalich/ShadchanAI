import { clsx } from 'clsx';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  ClipboardCheck,
  ClipboardList,
  Heart,
  Hourglass,
  Inbox,
  LayoutDashboard,
  MailOpen,
  MessageCircle,
  MessageSquare,
  Settings,
  Sparkles,
  UserCircle,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { matchesApi } from '@/services/api/matches';
import { extractionApi } from '@/services/api/extraction';
import { Badge } from '@/components/ui/primitives';

interface NavGroup {
  title?: string;
  items: Array<{ to: string; label: string; icon: ReactNode; end?: boolean; badge?: 'inbox' | 'failed' }>;
}

const NAV: NavGroup[] = [
  {
    items: [
      { to: '/', label: 'לוח בקרה', icon: <LayoutDashboard className="h-4 w-4" />, end: true },
    ],
  },
  {
    title: 'מועמדים',
    items: [
      { to: '/candidates/internal', label: 'מועמדים פנימיים', icon: <UserCircle className="h-4 w-4" /> },
      { to: '/candidates/external', label: 'מועמדים חיצוניים', icon: <Users className="h-4 w-4" /> },
      { to: '/candidates/failed', label: 'מועמדים שנכשלו', icon: <AlertTriangle className="h-4 w-4" />, badge: 'failed' },
    ],
  },
  {
    title: 'שידוך',
    items: [
      { to: '/inbox', label: 'תיבת ההצעות', icon: <MailOpen className="h-4 w-4" />, badge: 'inbox' },
      { to: '/matches', label: 'הצעות שידוך', icon: <Heart className="h-4 w-4" /> },
      { to: '/smart-matches', label: 'הצעה חכמה', icon: <Sparkles className="h-4 w-4" /> },
      { to: '/check-candidates', label: 'בדוק מועמדים', icon: <ClipboardCheck className="h-4 w-4" /> },
      { to: '/chats', label: 'שיחות', icon: <MessageSquare className="h-4 w-4" /> },
      { to: '/review', label: 'תור סקירת פרופילים', icon: <Inbox className="h-4 w-4" /> },
    ],
  },
  {
    title: 'תפעול',
    items: [
      { to: '/tasks', label: 'משימות ומעקב', icon: <ClipboardList className="h-4 w-4" /> },
      { to: '/channels', label: 'ערוצי WhatsApp', icon: <MessageCircle className="h-4 w-4" />, end: true },
      { to: '/channels/pending', label: 'ערוצים בהמתנה', icon: <Hourglass className="h-4 w-4" /> },
      { to: '/insights', label: 'תובנות', icon: <BarChart3 className="h-4 w-4" /> },
      { to: '/settings', label: 'הגדרות', icon: <Settings className="h-4 w-4" /> },
    ],
  },
];

// Live count of proposals awaiting a decision, shown beside the
// "תיבת ההצעות" nav item so pending work is visible from anywhere.
function InboxCountBadge() {
  const { data } = useQuery({
    queryKey: ['scan-results', 'inbox', { direction: '', minScore: '' }],
    queryFn: () => matchesApi.scanResults({ view: 'inbox', eligibleOnly: true, limit: 200 }),
  });
  const count = data?.data.length ?? 0;
  if (count === 0) return null;
  return <Badge tone="brand">{count}</Badge>;
}

// Count of extraction casualties that failed permanently and need manual
// entry — shown beside "מועמדים שנכשלו" so the backlog is visible from
// anywhere. (Transient failures live in the review page's "נפלו" tab.)
function FailedCountBadge() {
  const { data } = useQuery({
    queryKey: ['extraction', 'failed-queue'],
    queryFn: () => extractionApi.failedQueue(200),
  });
  const count = (data?.data ?? []).filter((f) => f.permanent).length;
  if (count === 0) return null;
  return <Badge tone="danger">{count}</Badge>;
}

export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void } = {}) {
  return (
    <>
      {/* Overlay — mobile only, behind the drawer */}
      <div
        onClick={onClose}
        className={clsx(
          'fixed inset-0 bg-black/30 z-40 transition-opacity lg:hidden',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        aria-hidden="true"
      />
      <aside
        className={clsx(
          'w-64 shrink-0 bg-white border-e border-border flex flex-col',
          // Off-canvas drawer below lg; static rail at lg+.
          'fixed inset-y-0 start-0 z-50 transition-transform lg:static lg:z-auto lg:translate-x-0',
          open ? 'translate-x-0' : 'rtl:translate-x-full ltr:-translate-x-full lg:rtl:translate-x-0 lg:ltr:translate-x-0',
        )}
      >
        <div className="px-5 py-5 border-b border-border">
          <div className="flex items-center gap-2">
            <img src="/favicon.svg" alt="שדכןAI" className="h-8 w-8 rounded-lg" />
            <div>
              <div className="text-base font-bold text-ink leading-none">שדכנAI</div>
              <div className="text-[10px] text-ink-faint mt-1 tracking-wide">ניהול</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto py-4">
          {NAV.map((group, i) => (
            <div key={i} className="mb-4">
              {group.title && (
                <div className="px-5 mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  {group.title}
                </div>
              )}
              <ul className="space-y-0.5 px-2">
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      onClick={onClose}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                          isActive
                            ? 'bg-brand-50 text-brand-700 font-semibold'
                            : 'text-ink-muted hover:bg-bg-hover hover:text-ink',
                        )
                      }
                    >
                      {item.icon}
                      <span className="flex-1">{item.label}</span>
                      {item.badge === 'inbox' && <InboxCountBadge />}
                      {item.badge === 'failed' && <FailedCountBadge />}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="border-t border-border px-5 py-4 text-xs text-ink-faint">
          גרסה 0.1 · פיתוח פעיל
        </div>
      </aside>
    </>
  );
}
