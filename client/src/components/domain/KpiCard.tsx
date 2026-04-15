import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '../ui/primitives';

export interface KpiCardProps {
  label: string;
  value: ReactNode;
  delta?: { direction: 'up' | 'down' | 'flat'; text: string };
  icon?: ReactNode;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}

const toneFg = {
  neutral: 'text-ink',
  good: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
};

export function KpiCard({ label, value, delta, icon, hint, tone = 'neutral' }: KpiCardProps) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-ink-muted uppercase tracking-wide">{label}</div>
          <div className={clsx('mt-1 text-2xl font-semibold num', toneFg[tone])}>{value}</div>
          {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
        </div>
        {icon && <div className="text-ink-subtle">{icon}</div>}
      </div>
      {delta && (
        <div className="mt-3 flex items-center gap-1.5 text-xs">
          {delta.direction === 'up' && <ArrowUp className="h-3.5 w-3.5 text-success" />}
          {delta.direction === 'down' && <ArrowDown className="h-3.5 w-3.5 text-danger" />}
          {delta.direction === 'flat' && <Minus className="h-3.5 w-3.5 text-ink-faint" />}
          <span className="text-ink-muted">{delta.text}</span>
        </div>
      )}
    </Card>
  );
}
