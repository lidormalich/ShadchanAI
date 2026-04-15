// ═══════════════════════════════════════════════════════════
// Empty / Loading / Error state components.
// ═══════════════════════════════════════════════════════════

import { clsx } from 'clsx';
import { AlertCircle, Inbox, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../ui/primitives';

export function EmptyState({
  icon = <Inbox className="h-10 w-10 text-ink-faint" />,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col items-center justify-center text-center py-12 px-6', className)}>
      <div className="mb-3">{icon}</div>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 text-sm text-ink-muted max-w-md">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'משהו השתבש',
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="mb-3 rounded-full bg-red-50 p-3">
        <AlertCircle className="h-6 w-6 text-danger" />
      </div>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 text-sm text-ink-muted max-w-md">{description}</p>}
      {onRetry && (
        <Button variant="secondary" onClick={onRetry} leftIcon={<RefreshCw className="h-4 w-4" />} className="mt-4">
          נסה שוב
        </Button>
      )}
    </div>
  );
}

export function LoadingSkeleton({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={clsx('space-y-3', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-4 w-full rounded" />
      ))}
    </div>
  );
}

export function RowSkeleton({ cols = 5 }: { cols?: number }) {
  return (
    <>
      {Array.from({ length: 6 }).map((_, r) => (
        <tr key={r} className="border-b border-border">
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} className="px-4 py-3">
              <div className="skeleton h-3.5 w-full rounded" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
