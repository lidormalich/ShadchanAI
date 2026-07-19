// ═══════════════════════════════════════════════════════════
// CandidatePicker — a designed replacement for the native <select>
// wherever the operator picks a candidate from a list.
//
//   • Trigger shows the chosen candidate as a person, not a string:
//     avatar + name + meta line, with a clear-selection ✕.
//   • The panel opens with a type-ahead search field (auto-focused),
//     avatar rows, the selected row checked, and a live result count.
//   • Full keyboard support: type to filter, ↑/↓ to move, Enter to
//     pick, Escape to close. Outside click closes.
//
// Two filtering modes:
//   • LOCAL (default) — pass the full `options` list; typing filters
//     it client-side by name/meta.
//   • SERVER — pass `onQueryChange`; the component debounces typing
//     (200ms) and reports the query, the caller re-fetches and feeds
//     new `options`. Pass `loading` for the fetch state and
//     `selectedOption` so the trigger can render the current pick
//     even when it's not in the latest result page.
//
// Deliberately dumb about data: callers map their candidates into
// CandidateOption ({ id, name, photoUrl?, meta? }), so internal and
// external candidates (or anything person-shaped) can share it.
// ═══════════════════════════════════════════════════════════

import { Check, ChevronDown, Search, UserRound, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Avatar, Spinner } from './primitives';

export interface CandidateOption {
  id: string;
  name: string;
  photoUrl?: string;
  /** Secondary line under the name — e.g. "24 · ירושלים · חרדי". */
  meta?: string;
}

export function CandidatePicker({
  options,
  value,
  onChange,
  placeholder = 'בחר מועמד/ת',
  searchPlaceholder = 'הקלד שם לחיפוש…',
  disabled,
  clearable = true,
  className,
  selectedOption,
  onQueryChange,
  loading,
  emptyMessage,
}: {
  options: CandidateOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  className?: string;
  /** Server mode: how to render the current value when it isn't in `options`. */
  selectedOption?: CandidateOption;
  /** Server mode: debounced query reporting — disables local filtering. */
  onQueryChange?: (query: string) => void;
  /** Server mode: fetch in flight. */
  loading?: boolean;
  /** Override the no-results text (e.g. "הקלד לפחות 2 תווים"). */
  emptyMessage?: string;
}) {
  const serverMode = !!onQueryChange;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = selectedOption?.id === value && value
    ? selectedOption
    : options.find((o) => o.id === value);

  const filtered = useMemo(() => {
    if (serverMode) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.name.toLowerCase().includes(q) || o.meta?.toLowerCase().includes(q),
    );
  }, [options, query, serverMode]);

  // Server mode: report typing after it settles — one request, not one
  // per keystroke.
  useEffect(() => {
    if (!serverMode) return;
    const t = setTimeout(() => onQueryChange!(query.trim()), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, serverMode]);

  // Opening resets the search and points the keyboard cursor at the
  // current selection so ↑/↓ continue from it, not from the top.
  const openPanel = (): void => {
    if (disabled) return;
    setQuery('');
    // Query was just reset, so (in local mode) the list is the full array.
    const idx = options.findIndex((o) => o.id === value);
    setActiveIndex(idx >= 0 ? idx : 0);
    setOpen(true);
  };

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Filtering can shrink the list under the cursor — clamp it back in.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Keep the keyboard-active row visible while arrowing through.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const pick = (id: string): void => {
    onChange(id);
    setOpen(false);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (opt) pick(opt.id);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className={clsx('relative', className)}>
      {/* ── Trigger ── */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={clsx(
          'w-full h-11 rounded-lg border bg-white px-2.5 text-start',
          'flex items-center gap-2.5 transition-colors',
          'focus-visible:border-brand-500 focus-visible:ring-1 focus-visible:ring-brand-500 outline-none',
          open ? 'border-brand-500 ring-1 ring-brand-500' : 'border-border hover:border-border-strong',
          disabled && 'bg-bg-subtle text-ink-subtle cursor-not-allowed',
        )}
      >
        {selected ? (
          <>
            <Avatar name={selected.name} size={28} src={selected.photoUrl} className="shrink-0" />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block text-sm font-medium text-ink truncate">{selected.name}</span>
              {selected.meta && (
                <span className="block text-[11px] text-ink-muted truncate">{selected.meta}</span>
              )}
            </span>
            {clearable && !disabled && (
              // Not a nested <button> — the whole trigger is one.
              <span
                role="button"
                aria-label="נקה בחירה"
                tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); onChange(''); }}
                className="shrink-0 rounded-full p-1 text-ink-faint hover:text-ink hover:bg-bg-hover"
              >
                <X className="h-3.5 w-3.5" />
              </span>
            )}
          </>
        ) : (
          <>
            <span className="shrink-0 h-7 w-7 rounded-full border border-dashed border-border-strong inline-flex items-center justify-center text-ink-faint">
              <UserRound className="h-4 w-4" />
            </span>
            <span className="flex-1 text-sm text-ink-muted truncate">{placeholder}</span>
          </>
        )}
        <ChevronDown
          className={clsx('h-4 w-4 shrink-0 text-ink-faint transition-transform duration-150', open && 'rotate-180')}
        />
      </button>

      {/* ── Panel ── */}
      {open && (
        <div
          className={clsx(
            'absolute start-0 end-0 top-full mt-1.5 z-50 min-w-[280px]',
            'rounded-xl border border-border bg-white shadow-rise overflow-hidden',
            'animate-dropdown-in origin-top',
          )}
        >
          <div className="relative border-b border-border bg-bg-subtle/60">
            <Search className="absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-ink-faint" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
              onKeyDown={onSearchKeyDown}
              placeholder={searchPlaceholder}
              className="w-full h-10 bg-transparent ps-9 pe-3 text-sm outline-none placeholder:text-ink-faint"
            />
            {loading && <Spinner className="absolute top-1/2 -translate-y-1/2 end-3 h-4 w-4 text-ink-faint" />}
          </div>

          <ul ref={listRef} role="listbox" className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-ink-muted">
                {loading
                  ? 'מחפש…'
                  : emptyMessage ?? (query.trim() ? `לא נמצאו מועמדים עבור „${query.trim()}”` : 'לא נמצאו מועמדים')}
              </li>
            )}
            {filtered.map((o, i) => {
              const isSelected = o.id === value;
              const isActive = i === activeIndex;
              return (
                <li key={o.id} data-index={i}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => pick(o.id)}
                    onMouseMove={() => setActiveIndex(i)}
                    className={clsx(
                      'w-full px-3 py-2 flex items-center gap-2.5 text-start transition-colors',
                      isActive && 'bg-bg-hover',
                      isSelected && 'bg-brand-50',
                    )}
                  >
                    <Avatar name={o.name} size={32} src={o.photoUrl} className="shrink-0" />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className={clsx('block text-sm truncate', isSelected ? 'font-semibold text-brand-700' : 'text-ink')}>
                        {o.name}
                      </span>
                      {o.meta && (
                        <span className="block text-[11px] text-ink-muted truncate">{o.meta}</span>
                      )}
                    </span>
                    {isSelected && <Check className="h-4 w-4 shrink-0 text-brand-600" />}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-border bg-bg-subtle/60 px-3 py-1.5 text-[11px] text-ink-faint num">
            {serverMode
              ? `${filtered.length} תוצאות`
              : query.trim()
                ? `${filtered.length} מתוך ${options.length} מועמדים`
                : `${options.length} מועמדים`}
          </div>
        </div>
      )}
    </div>
  );
}
