import { Badge } from '@/components/ui/primitives';

// Compact gender chip — ז (male) / נ (female) — for candidate tables and cards.
// Falls back to an em-dash when gender is missing (external profiles often are).
export function GenderBadge({ gender, className }: { gender?: string | null; className?: string }) {
  if (gender !== 'male' && gender !== 'female') {
    return <span className={className ?? 'text-ink-faint'}>—</span>;
  }
  const isMale = gender === 'male';
  return (
    <Badge tone={isMale ? 'info' : 'purple'} className={className}>
      {isMale ? 'ז' : 'נ'}
    </Badge>
  );
}
