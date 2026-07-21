// ═══════════════════════════════════════════════════════════
// Contextual banners: Dating, Deferred, Archived/Closed, Stale.
// ═══════════════════════════════════════════════════════════

import { AlertTriangle, Archive, Clock, Heart, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { Button } from '../ui/primitives';

interface BannerProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  tone: 'pink' | 'amber' | 'zinc' | 'red';
}

const toneClass = {
  pink: 'bg-pink-50 border-pink-200 text-pink-900',
  amber: 'bg-amber-50 border-amber-200 text-amber-900',
  zinc: 'bg-zinc-50 border-zinc-200 text-zinc-800',
  red: 'bg-red-50 border-red-200 text-red-900',
};

function Banner({ icon, title, description, action, tone }: BannerProps) {
  return (
    <div className={clsx('rounded-lg border px-4 py-3 flex items-start gap-3', toneClass[tone])}>
      <div className="pt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        {description && <div className="text-xs mt-0.5 opacity-90">{description}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function DatingStatusBanner({ partnerName, startedAt, onReopen }: {
  partnerName?: string;
  startedAt?: string;
  onReopen?: () => void;
}) {
  return (
    <Banner
      tone="pink"
      icon={<Heart className="h-5 w-5" />}
      title={`המועמד במצב היכרות${partnerName ? ` עם ${partnerName}` : ''}`}
      description={startedAt ? `החל מ־${new Date(startedAt).toLocaleDateString('he-IL')}` : undefined}
      action={
        onReopen && (
          <Button size="sm" variant="secondary" onClick={onReopen} leftIcon={<RotateCcw className="h-3.5 w-3.5" />}>
            פתיחה מחדש (לא הסתדר)
          </Button>
        )
      }
    />
  );
}

export function DeferredSuggestionsBanner({ count, onView }: { count: number; onView?: () => void }) {
  if (count <= 0) return null;
  return (
    <Banner
      tone="amber"
      icon={<Clock className="h-5 w-5" />}
      title={`${count} הצעות במצב השהיה`}
      description="הצעות שנדחו לנקודה מאוחרת יותר — אפשר לבחון פתיחה מחדש."
      action={
        onView && (
          <Button size="sm" variant="secondary" onClick={onView}>
            הצג
          </Button>
        )
      }
    />
  );
}

export function ClosedBanner({ reason, closedAt }: { reason?: string; closedAt?: string }) {
  return (
    <Banner
      tone="zinc"
      icon={<Archive className="h-5 w-5" />}
      title="המועמד סגור"
      description={[reason, closedAt && `מתאריך ${new Date(closedAt).toLocaleDateString('he-IL')}`].filter(Boolean).join(' — ')}
    />
  );
}

// Terminal match (closed / expired) — states plainly WHY it ended so the
// operator never has to guess. Neutral tone: a normal closure isn't an error.
export function MatchClosedBanner({ status, reason, closedAt }: {
  status: 'closed' | 'expired';
  reason?: string;
  closedAt?: string;
}) {
  const title = status === 'expired' ? 'ההצעה פגה' : 'ההצעה נסגרה';
  const parts = [
    reason?.trim() || 'לא נרשמה סיבת סגירה',
    closedAt && `מתאריך ${new Date(closedAt).toLocaleDateString('he-IL')}`,
  ].filter(Boolean);
  return (
    <Banner
      tone="zinc"
      icon={<Archive className="h-5 w-5" />}
      title={title}
      description={parts.join(' — ')}
    />
  );
}

export function StaleBanner({ daysSinceUpdate }: { daysSinceUpdate?: number }) {
  return (
    <Banner
      tone="amber"
      icon={<AlertTriangle className="h-5 w-5" />}
      title="פרופיל ישן"
      description={daysSinceUpdate ? `עודכן לפני ${daysSinceUpdate} ימים — יש לוודא זמינות לפני שליחה.` : 'יש לוודא את עדכני המידע.'}
    />
  );
}

export function BlockedBanner({ blockers }: { blockers: string[] }) {
  if (blockers.length === 0) return null;
  return (
    <Banner
      tone="red"
      icon={<AlertTriangle className="h-5 w-5" />}
      title="חסם לשליחה"
      description={blockers.join(' • ')}
    />
  );
}
