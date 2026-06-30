// ═══════════════════════════════════════════════════════════
// Reusable UI primitives — Button, Card, Badge, Input, Select,
// Textarea, Table (family), Tabs, Avatar, IconButton.
// Kept in one file for density; exported individually.
// ═══════════════════════════════════════════════════════════

import { clsx } from 'clsx';
import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from 'react';

// ── Button ───────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  loading?: boolean;
}

const btnVariant: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-700 disabled:bg-brand-500/50',
  secondary: 'bg-white border border-border text-ink hover:bg-bg-hover disabled:opacity-60',
  ghost: 'bg-transparent text-ink hover:bg-bg-hover disabled:opacity-60',
  danger: 'bg-danger text-white hover:bg-red-700 disabled:opacity-60',
  subtle: 'bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-60',
};

const btnSize: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-5 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', leftIcon, rightIcon, loading, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors',
        btnVariant[variant],
        btnSize[size],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner className="h-4 w-4" /> : leftIcon}
      <span>{children}</span>
      {!loading && rightIcon}
    </button>
  );
});

export function IconButton({ className, ...props }: ButtonProps) {
  return (
    <Button
      // Visual size stays 36px; below lg the tap target grows to ~44px.
      // Ghost background is transparent, so the glyph appears unchanged.
      className={clsx('h-9 w-9 p-0 max-lg:min-h-[44px] max-lg:min-w-[44px]', className)}
      variant={props.variant ?? 'ghost'}
      {...props}
    />
  );
}

// ── Spinner ──────────────────────────────────────────────
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={clsx('animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-label="loading"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 01-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ── Card ─────────────────────────────────────────────────

export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx('rounded-xl bg-bg-card border border-border shadow-card', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children, actions }: HTMLAttributes<HTMLDivElement> & { actions?: ReactNode }) {
  return (
    <div className={clsx('flex items-center justify-between gap-3 px-5 py-4 border-b border-border', className)}>
      <div className="min-w-0">{children}</div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('p-5', className)}>{children}</div>;
}

// ── Badge ────────────────────────────────────────────────

type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'purple';

const badgeTone: Record<BadgeTone, string> = {
  neutral: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  brand: 'bg-brand-50 text-brand-700 border-brand-100',
  success: 'bg-green-50 text-green-700 border-green-100',
  warning: 'bg-amber-50 text-amber-800 border-amber-100',
  danger: 'bg-red-50 text-red-700 border-red-100',
  info: 'bg-sky-50 text-sky-700 border-sky-100',
  purple: 'bg-purple-50 text-purple-700 border-purple-100',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
  icon,
  title,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
  icon?: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        badgeTone[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

// ── Input ────────────────────────────────────────────────

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={clsx(
          'h-9 w-full rounded-md border border-border bg-white px-3 text-sm',
          'placeholder:text-ink-faint',
          'focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none',
          'disabled:bg-bg-subtle disabled:text-ink-subtle',
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 4, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={clsx(
          'w-full rounded-md border border-border bg-white px-3 py-2 text-sm',
          'placeholder:text-ink-faint',
          'focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none',
          className,
        )}
        {...props}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={clsx(
          'h-9 rounded-md border border-border bg-white px-3 text-sm',
          'focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);

// ── Table family ─────────────────────────────────────────

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table className={clsx('w-full text-sm', className)} {...props} />
    </div>
  );
}
export function THead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className="bg-bg-subtle text-ink-muted" {...props} />;
}
export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className="divide-y divide-border" {...props} />;
}
export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={clsx('hover:bg-bg-hover/60', className)} {...props} />;
}
export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={clsx('px-4 py-2.5 text-start text-xs font-semibold uppercase tracking-wide', className)}
      {...props}
    />
  );
}
export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={clsx('px-4 py-3 align-middle', className)} {...props} />;
}

// ── Tabs (uncontrolled) ──────────────────────────────────

export interface TabDef {
  id: string;
  label: ReactNode;
  content: ReactNode;
  badge?: ReactNode;
}

export function Tabs({ tabs, initialId, className }: { tabs: TabDef[]; initialId?: string; className?: string }) {
  const [active, setActive] = useState(initialId ?? tabs[0]?.id);
  return (
    <div className={className}>
      <div className="flex gap-2 border-b border-border overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={clsx(
              'relative px-4 py-2.5 text-sm font-medium whitespace-nowrap',
              active === t.id
                ? 'text-brand-700 border-b-2 border-brand'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              {t.label}
              {t.badge}
            </span>
          </button>
        ))}
      </div>
      <div className="pt-4">
        {tabs.find((t) => t.id === active)?.content}
      </div>
    </div>
  );
}

// ── Avatar ───────────────────────────────────────────────

export function Avatar({
  name,
  size = 32,
  src,
  className,
}: {
  name?: string;
  size?: number;
  src?: string;
  className?: string;
}) {
  const initials = name
    ? name
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0])
        .join('')
        .toUpperCase()
    : '•';

  if (src) {
    return (
      <img
        src={src}
        alt={name ?? 'avatar'}
        style={{ width: size, height: size }}
        className={clsx('rounded-full object-cover', className)}
      />
    );
  }

  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className={clsx(
        'rounded-full bg-brand-100 text-brand-700 font-semibold inline-flex items-center justify-center',
        className,
      )}
    >
      {initials}
    </div>
  );
}

// ── Divider ──────────────────────────────────────────────

export function Divider({ className }: { className?: string }) {
  return <div className={clsx('h-px bg-border', className)} />;
}
