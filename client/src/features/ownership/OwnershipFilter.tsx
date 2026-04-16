// ═══════════════════════════════════════════════════════════
// Tri-state ownership filter control (Phase 3).
// Pass as a query param `ownership` to list endpoints that
// accept it. "team" currently behaves identically to "all"
// on the backend — kept as a distinct choice so the UI is
// forward-compatible with future org/team boundaries.
// ═══════════════════════════════════════════════════════════

export type OwnershipScope = 'mine' | 'team' | 'all';

export function OwnershipFilter({
  value,
  onChange,
}: {
  value: OwnershipScope;
  onChange: (v: OwnershipScope) => void;
}) {
  const options: Array<{ id: OwnershipScope; label: string }> = [
    { id: 'mine', label: 'שלי' },
    { id: 'team', label: 'צוות' },
    { id: 'all', label: 'הכול' },
  ];
  return (
    <div className="inline-flex rounded-md bg-bg-subtle border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`text-xs px-3 py-1 rounded ${value === o.id ? 'bg-white shadow-sm font-medium text-ink' : 'text-ink-muted'}`}
          title={o.id === 'team' ? 'צוות: יוצג כמו "הכול" עד שיתווסף מודל צוותים' : undefined}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
