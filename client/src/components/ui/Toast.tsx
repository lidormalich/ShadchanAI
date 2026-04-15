// ═══════════════════════════════════════════════════════════
// Lightweight toast system — no external deps.
//
// Usage:
//   import { toast } from '@/components/ui/Toast';
//   toast.success('הפעולה בוצעה');
//   toast.error('הפעולה נכשלה', 'פרטים נוספים');
//
// Mount <ToastRegion /> once near the top of the app tree.
// ═══════════════════════════════════════════════════════════

import { clsx } from 'clsx';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

interface ToastMsg {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

type Listener = (msgs: ToastMsg[]) => void;

let nextId = 1;
let state: ToastMsg[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(state);
}

function push(tone: ToastTone, title: string, description?: string, durationMs = 4500) {
  const id = nextId++;
  state = [...state, { id, tone, title, description }];
  emit();
  setTimeout(() => {
    state = state.filter((t) => t.id !== id);
    emit();
  }, durationMs);
}

export const toast = {
  success: (title: string, description?: string) => push('success', title, description),
  error: (title: string, description?: string) => push('error', title, description, 6500),
  info: (title: string, description?: string) => push('info', title, description),
  warning: (title: string, description?: string) => push('warning', title, description, 6500),
};

const toneClass: Record<ToastTone, string> = {
  success: 'bg-green-50 border-green-200 text-green-900',
  error: 'bg-red-50 border-red-200 text-red-900',
  info: 'bg-sky-50 border-sky-200 text-sky-900',
  warning: 'bg-amber-50 border-amber-200 text-amber-900',
};

const toneIcon: Record<ToastTone, ReactNode> = {
  success: <CheckCircle2 className="h-5 w-5" />,
  error: <AlertCircle className="h-5 w-5" />,
  info: <Info className="h-5 w-5" />,
  warning: <AlertCircle className="h-5 w-5" />,
};

export function ToastRegion() {
  const [msgs, setMsgs] = useState<ToastMsg[]>(state);
  useEffect(() => {
    const l: Listener = (m) => setMsgs([...m]);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  return (
    <div className="fixed bottom-4 end-4 z-[100] flex flex-col gap-2 w-[360px] max-w-[90vw]">
      {msgs.map((m) => (
        <div key={m.id} className={clsx('rounded-lg border shadow-rise p-3 flex items-start gap-3', toneClass[m.tone])}>
          <div className="pt-0.5">{toneIcon[m.tone]}</div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">{m.title}</div>
            {m.description && <div className="text-xs mt-0.5 opacity-90 whitespace-pre-wrap">{m.description}</div>}
          </div>
          <button
            onClick={() => { state = state.filter((t) => t.id !== m.id); emit(); }}
            className="opacity-60 hover:opacity-100"
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
