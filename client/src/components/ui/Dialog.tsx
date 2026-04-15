import { clsx } from 'clsx';
import { useEffect, type ReactNode } from 'react';
import { Button } from './primitives';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  primaryAction?: { label: string; onClick: () => void; loading?: boolean; variant?: 'primary' | 'danger' };
  secondaryAction?: { label: string; onClick: () => void };
}

export function Dialog({ open, onClose, title, description, children, primaryAction, secondaryAction }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className={clsx('relative bg-bg-card rounded-xl shadow-rise w-[440px] max-w-full p-5 mx-4')} role="dialog" aria-modal="true">
        <h3 className="text-lg font-semibold text-ink">{title}</h3>
        {description && <p className="mt-2 text-sm text-ink-muted">{description}</p>}
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">
          {secondaryAction && (
            <Button variant="secondary" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
          {primaryAction && (
            <Button
              variant={primaryAction.variant ?? 'primary'}
              onClick={primaryAction.onClick}
              loading={primaryAction.loading}
            >
              {primaryAction.label}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export interface ConfirmActionModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  variant?: 'primary' | 'danger';
  onConfirm: () => void;
  loading?: boolean;
}

export function ConfirmActionModal({
  open, onClose, title, description, confirmLabel = 'אשר', variant = 'primary', onConfirm, loading,
}: ConfirmActionModalProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      primaryAction={{ label: confirmLabel, onClick: onConfirm, loading, variant }}
      secondaryAction={{ label: 'ביטול', onClick: onClose }}
    />
  );
}
