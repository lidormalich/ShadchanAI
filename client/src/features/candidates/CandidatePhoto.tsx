// ═══════════════════════════════════════════════════════════
// CandidatePhoto — avatar that shows the candidate's stored photo
// (served auth-gated from R2 via the media proxy) with an inline
// "replace photo" control. Falls back to initials when no photo.
// ═══════════════════════════════════════════════════════════

import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera } from 'lucide-react';
import { Avatar } from '@/components/ui/primitives';
import { AuthImage } from '@/components/AuthImage';
import { internalCandidatesApi } from '@/services/api/candidates';
import { toast } from '@/components/ui/Toast';

const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 6 * 1024 * 1024;

export function CandidatePhoto({ candidateId, name, photoUrl, size = 56 }: {
  candidateId: string;
  name: string;
  photoUrl?: string;
  size?: number;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (file: File) => internalCandidatesApi.uploadPhoto(candidateId, file),
    onSuccess: () => {
      toast.success('התמונה עודכנה');
      qc.invalidateQueries({ queryKey: ['internal', candidateId] });
    },
    onError: (e) => toast.error('העלאת התמונה נכשלה', (e as Error).message),
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (!ACCEPT.includes(file.type)) {
      toast.error('פורמט לא נתמך', 'ניתן להעלות JPG / PNG / WEBP בלבד');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('הקובץ גדול מדי', 'גודל מרבי 6MB');
      return;
    }
    upload.mutate(file);
  };

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="h-full w-full overflow-hidden rounded-full bg-bg-subtle"
        style={{ width: size, height: size }}
      >
        {photoUrl ? (
          <AuthImage src={photoUrl} alt={name} className="h-full w-full object-cover" />
        ) : (
          <Avatar name={name} size={size} />
        )}
      </div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={upload.isPending}
        title="החלף תמונה"
        aria-label="החלף תמונה"
        className="absolute -bottom-1 -end-1 grid h-6 w-6 place-items-center rounded-full border border-border bg-bg shadow-sm hover:bg-bg-subtle disabled:opacity-50"
      >
        <Camera className="h-3.5 w-3.5 text-ink-muted" />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT.join(',')}
        className="hidden"
        onChange={onPick}
      />
    </div>
  );
}
