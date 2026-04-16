import { ChevronLeft, LogOut, Plus, Sparkles } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Avatar, Button } from '../components/ui/primitives';
import { AskAIPanel } from '../features/ai/AskAIPanel';
import { useAuth } from '../features/auth/AuthContext';
import { TopbarSearch } from '../features/search/TopbarSearch';
import { NotificationsBell } from '../features/notifications/NotificationsBell';

// ── Route → breadcrumb map ────────────────────────────────

function breadcrumbsFor(pathname: string): Array<{ label: string; to?: string }> {
  const crumbs: Array<{ label: string; to?: string }> = [{ label: 'ראשי', to: '/' }];
  const parts = pathname.split('/').filter(Boolean);
  const labelMap: Record<string, string> = {
    candidates: 'מועמדים',
    internal: 'פנימיים',
    external: 'חיצוניים',
    matches: 'הצעות שידוך',
    chats: 'שיחות',
    channels: 'ערוצים',
    tasks: 'משימות',
    insights: 'תובנות',
    settings: 'הגדרות',
  };
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ label: labelMap[part] ?? part, to: acc });
  }
  return crumbs;
}

export function Topbar({ actions }: { actions?: ReactNode }) {
  const { pathname } = useLocation();
  const crumbs = breadcrumbsFor(pathname);
  const pageTitle = crumbs[crumbs.length - 1]?.label ?? 'שדכנAI';

  const [askOpen, setAskOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="h-16 bg-white border-b border-border flex items-center px-6 gap-4 sticky top-0 z-30">
      <div className="flex-1 min-w-0">
        <nav aria-label="breadcrumb" className="text-xs text-ink-faint flex items-center gap-1 flex-wrap">
          {crumbs.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              {i > 0 && <ChevronLeft className="h-3 w-3 rtl:rotate-180" />}
              {c.to && i < crumbs.length - 1 ? (
                <Link to={c.to} className="hover:text-ink">{c.label}</Link>
              ) : (
                <span className="text-ink">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
        <h1 className="text-xl font-semibold text-ink truncate">{pageTitle}</h1>
      </div>

      <TopbarSearch />

      <Button
        variant="subtle"
        leftIcon={<Sparkles className="h-4 w-4" />}
        onClick={() => setAskOpen(true)}
      >
        Ask AI
      </Button>

      <div className="relative">
        <Button
          variant="secondary"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => setMenuOpen((v) => !v)}
        >
          פעולה חדשה
        </Button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute end-0 top-11 w-56 bg-white border border-border rounded-lg shadow-rise z-50 py-1.5">
              <QuickAction to="/candidates/internal" label="הוסף מועמד פנימי" onClose={() => setMenuOpen(false)} />
              <QuickAction to="/candidates/external" label="הוסף מועמד חיצוני" onClose={() => setMenuOpen(false)} />
              <QuickAction to="/matches" label="צור הצעת שידוך ידנית" onClose={() => setMenuOpen(false)} />
              <QuickAction to="/chats" label="פתח שיחות" onClose={() => setMenuOpen(false)} />
              <QuickAction to="/tasks" label="צור משימה" onClose={() => setMenuOpen(false)} />
            </div>
          </>
        )}
      </div>

      {actions}

      <NotificationsBell />

      <UserMenu />

      <AskAIPanel open={askOpen} onClose={() => setAskOpen(false)} />
    </header>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 ps-2 border-s border-border hover:opacity-80"
      >
        <Avatar name={user?.name ?? 'משתמש'} size={32} />
        <div className="hidden md:block text-sm leading-tight text-start">
          <div className="font-medium text-ink">{user?.name ?? 'משתמש'}</div>
          <div className="text-xs text-ink-faint">{user?.roles?.[0] ?? 'guest'}</div>
        </div>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute end-0 top-11 w-48 bg-white border border-border rounded-lg shadow-rise z-50 py-1.5">
            <button
              onClick={() => { setOpen(false); logout(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-bg-hover text-start"
            >
              <LogOut className="h-4 w-4" /> התנתק
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function QuickAction({ to, label, onClose }: { to: string; label: string; onClose: () => void }) {
  return (
    <Link to={to} onClick={onClose} className="block px-3 py-2 text-sm text-ink hover:bg-bg-hover">
      {label}
    </Link>
  );
}
