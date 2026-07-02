// ═══════════════════════════════════════════════════════════
// StatusReasonDialog — the learning loop's input point.
//
// Opens on status-changing actions (approve / mark-dating) and asks
// the operator WHY. The free-text reason is stored on the suggestion's
// status history and feeds the candidate-learning agent ("מה למדנו").
// "אישור" confirms with the text (may be empty), "דלג" confirms with
// no reason — the action itself always proceeds.
// ═══════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Textarea } from '@/components/ui/primitives';

export function StatusReasonDialog({
  open, title, onClose, onConfirm, loading,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onConfirm: (reason?: string) => void;
  loading?: boolean;
}) {
  const [reason, setReason] = useState('');

  // Fresh textarea on every open — a reason belongs to one decision only.
  useEffect(() => { if (open) setReason(''); }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      primaryAction={{
        label: 'אישור',
        onClick: () => onConfirm(reason.trim() || undefined),
        loading,
      }}
      secondaryAction={{ label: 'דלג', onClick: () => onConfirm(undefined) }}
    >
      <Textarea
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="למה בחרת בסטטוס הזה? התשובה עוזרת למערכת ללמוד את המועמד ולדייק הצעות הבאות"
      />
    </Dialog>
  );
}
