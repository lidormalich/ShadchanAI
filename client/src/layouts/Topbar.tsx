import { ChevronLeft, LogOut, Menu, Plus, Search, Sparkles, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Avatar, Button, IconButton } from '../components/ui/primitives';
import { AskAIPanel } from '../features/ai/AskAIPanel';
import { useAuth } from '../features/auth/AuthContext';
import { TopbarSearch } from '../features/search/TopbarSearch';
import { NotificationsBell } from '../features/notifications/NotificationsBell';
import { usePageTitle } from './PageTitleContext';

// ── Route → breadcrumb map ────────────────────────────────

const LABEL_MAP: Record<string, string> = {
  candidates: 'מועמדים',
  internal: 'פנימיים',
  external: 'חיצוניים',
  inbox: 'תיבת ההצעות',
  matches: 'הצעות שידוך',
  'smart-matches': 'הצעה חכמה',
  'check-candidates': 'בדיקת מועמדים',
  chats: 'שיחות',
  channels: 'ערוצים',
  mappings: 'מיפויים',
  pending: 'בהמתנה',
  review: 'תור סקירת פרופילים',
  tasks: 'משימות',
  insights: 'תובנות',
  monitoring: 'ניטור',
  settings: 'הגדרות',
};

function breadcrumbsFor(pathname: string): Array<{ label: string; to?: string }> {
  const crumbs: Array<{ label: string; to?: string }> = [{ label: 'ראשי', to: '/' }];
  const parts = pathname.split('/').filter(Boolean);
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ label: LABEL_MAP[part] ?? part, to: acc });
  }
  return crumbs;
}

export function Topbar({ actions, onOpenNav }: { actions?: ReactNode; onOpenNav?: () => void }) {
  const { pathname } = useLocation();
  const { title } = usePageTitle();
  const baseCrumbs = useMemo(() => breadcrumbsFor(pathname), [pathname]);
  // A page may override the last crumb (e.g. a match detail showing the
  // pair's names instead of the raw id from the URL).
  const crumbs = title
    ? baseCrumbs.map((c, i) => (i === baseCrumbs.length - 1 ? { ...c, label: title } : c))
    : baseCrumbs;
  const pageTitle = crumbs[crumbs.length - 1]?.label ?? 'שדכנAI';

  const [askOpen, setAskOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <header className="relative h-16 bg-white border-b border-border flex items-center px-4 sm:px-6 gap-2 sm:gap-4 sticky top-0 z-30">
      {/* Mobile nav toggle */}
      <IconButton
        className="lg:hidden"
        aria-label="תפריט"
        onClick={onOpenNav}
      >
        <Menu className="h-5 w-5" />
      </IconButton>

      <div className="flex-1 min-w-0">
        <nav aria-label="breadcrumb" className="text-xs text-ink-faint hidden sm:flex items-center gap-1 flex-wrap">
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
        <h1 className="text-lg sm:text-xl font-semibold text-ink truncate">{pageTitle}</h1>
      </div>

      <TopbarSearch />

      {/* Mobile search trigger */}
      <IconButton
        className="lg:hidden"
        aria-label="חיפוש"
        onClick={() => setSearchOpen(true)}
      >
        <Search className="h-5 w-5" />
      </IconButton>

      <Button
        variant="subtle"
        leftIcon={<Sparkles className="h-4 w-4" />}
        onClick={() => setAskOpen(true)}
        aria-label="Ask AI"
      >
        <span className="hidden sm:inline">Ask AI</span>
      </Button>

      <div className="relative">
        <Button
          variant="secondary"
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="פעולה חדשה"
        >
          <span className="hidden sm:inline">פעולה חדשה</span>
        </Button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute end-0 top-11 w-56 bg-white border border-border rounded-lg shadow-rise z-50 py-1.5">
              <QuickAction to="/candidates/internal" label="הוסף מועמד פנימי" onClose={() => setMenuOpen(false)} />
              <QuickAction to="/candidates/external" label="הוסף מועמד חיצוני" onClose={() => setMenuOpen(false)} />
              <QuickAction to="/matches?new=1" label="צור הצעת שידוך ידנית" onClose={() => setMenuOpen(false)} />
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

      {/* Mobile search overlay — covers the topbar with a full-width field */}
      {searchOpen && (
        <div className="absolute inset-x-0 top-0 h-16 bg-white border-b border-border flex items-center gap-2 px-4 z-40 lg:hidden">
          <div className="flex-1">
            <TopbarSearch variant="overlay" autoFocus onResultNavigate={() => setSearchOpen(false)} />
          </div>
          <IconButton aria-label="סגור חיפוש" onClick={() => setSearchOpen(false)}>
            <X className="h-5 w-5" />
          </IconButton>
        </div>
      )}
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
