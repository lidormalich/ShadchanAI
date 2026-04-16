// ═══════════════════════════════════════════════════════════
// Minimal owner / assignee chip — resolves a userId to a name
// via useUsers() and renders a compact avatar + label. If the
// directory hasn't resolved yet or the id isn't in it, shows a
// neutral placeholder rather than a bare mongo id.
// ═══════════════════════════════════════════════════════════

import { Avatar } from '@/components/ui/primitives';
import { useUserById } from './useUsers';

export function OwnerChip({
  userId,
  label = 'בעלים',
  size = 20,
}: {
  userId?: string;
  label?: string;
  size?: number;
}) {
  const user = useUserById(userId);

  if (!userId) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint">
        <span className="w-4 h-4 rounded-full bg-bg-subtle border border-border inline-block" />
        {label}: לא שויך
      </span>
    );
  }

  const name = user?.name ?? `#${userId.slice(-6)}`;

  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] text-ink-muted"
      title={user?.email ? `${name} · ${user.email}` : name}
    >
      <Avatar name={name} size={size} />
      <span>{label}: <span className="text-ink">{name}</span></span>
    </span>
  );
}
