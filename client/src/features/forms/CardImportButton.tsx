// ═══════════════════════════════════════════════════════════
// Shared "הזנת כרטיס שלם" affordance for the candidate intake forms.
//
// A compact button that opens a modal with a paste box. On "מלא עם AI"
// it calls the unified extraction service and hands the raw superset
// back to the parent via onExtracted — the parent maps it to its own
// form fields (internal vs external mapping differs).
//
// Keeps the form itself clean: the textarea lives in the modal, not
// inline taking up vertical space.
// ═══════════════════════════════════════════════════════════

import { useMutation } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Textarea } from '@/components/ui/primitives';
import { toast } from '@/components/ui/Toast';
import { aiApi, type ProfileExtraction } from '@/services/api/ai';

export function CardImportButton({
  target,
  onExtracted,
}: {
  target: 'internal' | 'external';
  onExtracted: (profile: ProfileExtraction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  const extract = useMutation({
    mutationFn: () => aiApi.extractProfile({ text: text.trim(), target }),
    onSuccess: (res) => {
      onExtracted(res.data);
      setOpen(false);
      setText('');
    },
    onError: (err) => toast.error('החילוץ נכשל', (err as Error).message),
  });

  const close = () => {
    if (extract.isPending) return; // don't yank the modal mid-request
    setOpen(false);
  };

  return (
    <>
      <Button
        type="button"
        variant="subtle"
        className="w-full"
        leftIcon={<Sparkles className="h-4 w-4" />}
        onClick={() => setOpen(true)}
      >
        הזנת כרטיס שלם — מילוי אוטומטי
      </Button>

      <Dialog
        open={open}
        onClose={close}
        title="הזנת כרטיס שלם"
        description="הדבק את טקסט הכרטיס (כמו שמגיע בוואטסאפ) וה-AI ימלא את שדות הטופס. תוכל לבדוק ולתקן לפני שמירה."
        primaryAction={{
          label: 'מלא עם AI',
          onClick: () => extract.mutate(),
          loading: extract.isPending,
          disabled: text.trim().length < 10,
        }}
        secondaryAction={{ label: 'ביטול', onClick: close }}
      >
        <Textarea
          rows={10}
          autoFocus
          placeholder="הדבק כאן את פרטי המועמד..."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-1 text-xs text-ink-faint">{text.trim().length} תווים</div>
      </Dialog>
    </>
  );
}
