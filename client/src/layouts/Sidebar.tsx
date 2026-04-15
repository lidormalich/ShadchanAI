import { clsx } from 'clsx';
import {
  BarChart3,
  ClipboardList,
  Heart,
  Inbox,
  LayoutDashboard,
  MessageCircle,
  MessageSquare,
  Settings,
  UserCircle,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

interface NavGroup {
  title?: string;
  items: Array<{ to: string; label: string; icon: ReactNode; end?: boolean }>;
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
    ],
  },
  {
    title: 'שידוך',
    items: [
      { to: '/matches', label: 'הצעות שידוך', icon: <Heart className="h-4 w-4" /> },
      { to: '/chats', label: 'שיחות', icon: <MessageSquare className="h-4 w-4" /> },
      { to: '/review', label: 'תור סקירת פרופילים', icon: <Inbox className="h-4 w-4" /> },
    ],
  },
  {
    title: 'תפעול',
    items: [
      { to: '/tasks', label: 'משימות ומעקב', icon: <ClipboardList className="h-4 w-4" /> },
      { to: '/channels', label: 'ערוצי WhatsApp', icon: <MessageCircle className="h-4 w-4" /> },
      { to: '/insights', label: 'תובנות', icon: <BarChart3 className="h-4 w-4" /> },
      { to: '/settings', label: 'הגדרות', icon: <Settings className="h-4 w-4" /> },
    ],
  },
];

export function Sidebar() {
  return (
    <aside className="w-64 shrink-0 bg-white border-e border-border flex flex-col">
      <div className="px-5 py-5 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-brand flex items-center justify-center text-white font-bold">ש</div>
          <div>
            <div className="text-base font-bold text-ink leading-none">שדכנAI</div>
            <div className="text-[10px] text-ink-faint mt-1 tracking-wide uppercase">Admin</div>
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
                    <span>{item.label}</span>
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
  );
}
