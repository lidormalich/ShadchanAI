// ═══════════════════════════════════════════════════════════
// PhotoTab — candidate photo management (internal + external).
//
//   • upload / replace / remove the photo (stored in R2)
//   • create a PUBLIC share link (no login) that opens just the image
//   • copy the candidate card text, with or without the photo link,
//     ready to paste into WhatsApp
// ═══════════════════════════════════════════════════════════

import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera, Copy, ExternalLink, ImageOff, Link2, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import { AuthImage } from '@/components/AuthImage';
import { toast } from '@/components/ui/Toast';
import {
  internalCandidatesApi,
  externalCandidatesApi,
  type PhotoShareLink,
} from '@/services/api/candidates';

const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 6 * 1024 * 1024;

interface PhotoApi {
  uploadPhoto(id: string, file: File): Promise<unknown>;
  removePhoto(id: string): Promise<unknown>;
  photoShareLink(id: string): Promise<PhotoShareLink>;
}

export function PhotoTab({ type, candidateId, name, photoUrl, cardText }: {
  type: 'internal' | 'external';
  candidateId: string;
  name: string;
  photoUrl?: string;
  /** Pre-built card text to copy (the parent knows the candidate's fields). */
  cardText: string;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const photoApi = (type === 'internal' ? internalCandidatesApi : externalCandidatesApi) as unknown as PhotoApi;
  const invalidate = () => qc.invalidateQueries({ queryKey: [type, candidateId] });

  const upload = useMutation({
    mutationFn: (file: File) => photoApi.uploadPhoto(candidateId, file),
    onSuccess: () => { toast.success('התמונה עודכנה'); setShareUrl(null); invalidate(); },
    onError: (e) => toast.error('העלאת התמונה נכשלה', (e as Error).message),
  });

  const remove = useMutation({
    mutationFn: () => photoApi.removePhoto(candidateId),
    onSuccess: () => { toast.success('התמונה הוסרה'); setShareUrl(null); invalidate(); },
    onError: (e) => toast.error('ההסרה נכשלה', (e as Error).message),
  });

  const share = useMutation({
    mutationFn: () => photoApi.photoShareLink(candidateId),
    onSuccess: (d) => { setShareUrl(d.url); toast.success('לינק שיתוף נוצר'); },
    onError: (e) => toast.error('יצירת הלינק נכשלה', (e as Error).message),
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ACCEPT.includes(file.type)) { toast.error('פורמט לא נתמך', 'JPG / PNG / WEBP בלבד'); return; }
    if (file.size > MAX_BYTES) { toast.error('הקובץ גדול מדי', 'עד 6MB'); return; }
    upload.mutate(file);
  };

  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); toast.success(label); }
    catch { toast.error('ההעתקה נכשלה'); }
  };

  const copyCard = async () => {
    let link = shareUrl;
    if (photoUrl && !link) {
      try { link = (await photoApi.photoShareLink(candidateId)).url; setShareUrl(link); } catch { /* copy without link */ }
    }
    const text = link ? `${cardText}\n\n📷 ${link}` : cardText;
    await copy(text, link ? 'הכרטיס הועתק (כולל לינק לתמונה)' : 'הכרטיס הועתק (ללא תמונה)');
  };

  const busy = upload.isPending || remove.isPending;

  return (
    <div className="space-y-5 max-w-xl">
      {/* Photo preview */}
      <div className="flex items-start gap-4">
        <div className="h-40 w-40 shrink-0 overflow-hidden rounded-lg border border-border bg-bg-subtle grid place-items-center">
          {photoUrl ? (
            <AuthImage src={photoUrl} alt={name} className="h-full w-full object-cover" />
          ) : (
            <div className="text-center text-ink-faint">
              <ImageOff className="h-8 w-8 mx-auto mb-1" />
              <div className="text-xs">אין תמונה</div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Button
            size="sm"
            leftIcon={photoUrl ? <Camera className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
            loading={upload.isPending}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {photoUrl ? 'החלף תמונה' : 'העלה תמונה'}
          </Button>
          {photoUrl && (
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<Trash2 className="h-4 w-4" />}
              loading={remove.isPending}
              disabled={busy}
              onClick={() => remove.mutate()}
            >
              הסר תמונה
            </Button>
          )}
          <p className="text-xs text-ink-faint">JPG / PNG / WEBP · עד 6MB</p>
        </div>
      </div>

      {/* Public share link */}
      <div className="rounded-lg border border-border p-3 space-y-2">
        <div className="text-sm font-medium">שיתוף</div>
        <p className="text-xs text-ink-muted">
          לינק ציבורי לתמונה (ללא צורך בהתחברות) — מתאים לשליחה בוואטסאפ.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Link2 className="h-4 w-4" />}
            loading={share.isPending}
            disabled={!photoUrl}
            onClick={() => share.mutate()}
          >
            צור לינק לתמונה
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Copy className="h-4 w-4" />}
            onClick={copyCard}
          >
            העתק כרטיס {photoUrl ? '+ לינק' : ''}
          </Button>
        </div>
        {!photoUrl && <p className="text-xs text-ink-faint">אין תמונה — יועתק הכרטיס בלבד.</p>}
        {shareUrl && (
          <div className="flex items-center gap-2">
            <a
              href={shareUrl}
              target="_blank"
              rel="noreferrer"
              title={shareUrl}
              className="flex-1 min-w-0 truncate rounded-md border border-border bg-bg-subtle px-2 py-1 text-xs text-brand hover:underline"
            >
              {shareUrl}
            </a>
            <Button size="sm" variant="secondary" leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
              onClick={() => window.open(shareUrl, '_blank', 'noopener')}>
              פתח
            </Button>
            <Button size="sm" variant="ghost" leftIcon={<Copy className="h-3.5 w-3.5" />}
              onClick={() => copy(shareUrl, 'הלינק הועתק')}>
              העתק
            </Button>
          </div>
        )}
      </div>

      <input ref={inputRef} type="file" accept={ACCEPT.join(',')} className="hidden" onChange={onPick} />
    </div>
  );
}
