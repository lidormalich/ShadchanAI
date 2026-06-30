import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { IconButton } from './primitives';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  width?: 'md' | 'lg' | 'xl';
  footer?: ReactNode;
  children: ReactNode;
}

// Full-width on phones; fixed desktop widths from sm+.
const widthClass = { md: 'w-full sm:w-[520px]', lg: 'w-full sm:w-[720px]', xl: 'w-full sm:w-[900px]' };

export function Drawer({ open, onClose, title, subtitle, width = 'lg', footer, children }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        className={clsx(
          'fixed inset-0 bg-black/30 transition-opacity z-40',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
      />
      {/* Panel — slides from the inline-start edge (LTR: left, RTL: right) */}
      <aside
        className={clsx(
          'fixed top-0 bottom-0 start-0 z-50 bg-bg-card border-e border-border shadow-rise',
          'flex flex-col transition-transform',
          widthClass[width],
          open ? 'translate-x-0' : 'rtl:translate-x-full ltr:-translate-x-full',
        )}
        role="dialog"
        aria-modal="true"
      >
        {(title || subtitle) && (
          <header className="flex items-start justify-between gap-3 p-4 sm:p-5 border-b border-border">
            <div className="min-w-0">
              {title && <h2 className="text-lg font-semibold text-ink">{title}</h2>}
              {subtitle && <p className="text-sm text-ink-muted mt-0.5">{subtitle}</p>}
            </div>
            <IconButton onClick={onClose} aria-label="close">
              <X className="h-4 w-4" />
            </IconButton>
          </header>
        )}
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && (
          <footer className="border-t border-border p-4 bg-bg-subtle sticky bottom-0">
            {footer}
          </footer>
        )}
      </aside>
    </>
  );
}
