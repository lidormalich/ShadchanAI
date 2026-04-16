// ═══════════════════════════════════════════════════════════
// Topbar search (Phase 5).
// Debounced query → GET /api/search. Compact results dropdown.
// Each row is a direct link into the relevant working surface.
// ═══════════════════════════════════════════════════════════

import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input } from '@/components/ui/primitives';
import { searchApi, type SearchResult } from '@/services/api/search';

const TYPE_LABEL: Record<SearchResult['type'], string> = {
  internal_candidate: 'פנימי',
  external_candidate: 'חיצוני',
  match: 'הצעה',
  conversation: 'שיחה',
  task: 'משימה',
};

export function TopbarSearch() {
  const [raw, setRaw] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);

  // 200ms debounce — enough for fast typing not to storm the API.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(raw.trim()), 200);
    return () => clearTimeout(id);
  }, [raw]);

  // Close dropdown on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const q = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => searchApi.query(debounced, 12),
    enabled: debounced.length >= 2,
    staleTime: 10_000,
  });

  const results = debounced.length >= 2 ? (q.data?.data ?? []) : [];

  const go = (r: SearchResult): void => {
    setOpen(false);
    setRaw('');
    navigate(r.route);
  };

  return (
    <div ref={wrapRef} className="w-80 relative hidden lg:block">
      <Search className="absolute top-1/2 -translate-y-1/2 start-3 h-4 w-4 text-ink-faint" />
      <Input
        placeholder="חיפוש מועמדים, הצעות, שיחות…"
        className="ps-9"
        value={raw}
        onChange={(e) => { setRaw(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Enter' && results[0]) go(results[0]);
        }}
      />

      {open && debounced.length >= 2 && (
        <div className="absolute start-0 end-0 top-11 bg-white border border-border rounded-lg shadow-rise z-50 max-h-96 overflow-y-auto">
          {q.isLoading ? (
            <div className="p-3 text-xs text-ink-muted">מחפש…</div>
          ) : results.length === 0 ? (
            <div className="p-3 text-xs text-ink-muted">לא נמצאו תוצאות</div>
          ) : (
            <ul className="py-1">
              {results.map((r) => (
                <li key={r.type + ':' + r.id}>
                  <button
                    type="button"
                    onClick={() => go(r)}
                    className="w-full text-start px-3 py-2 hover:bg-bg-hover flex items-center gap-2"
                  >
                    <span className="text-[11px] text-ink-faint shrink-0 w-12">{TYPE_LABEL[r.type]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="text-sm text-ink truncate block">{r.title}</span>
                      {r.subtitle && <span className="text-[11px] text-ink-muted truncate block">{r.subtitle}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
