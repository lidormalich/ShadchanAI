// ═══════════════════════════════════════════════════════════
// PhotoTab — candidate photo management (internal + external).
//
//   • upload / replace / remove the photo (stored in R2)
//   • a PUBLIC share link (no login) that opens just the image
//   • copy the candidate card text, with or without the photo link,
//     ready to paste into WhatsApp
//
// The share link is fetched EAGERLY (as soon as a photo exists) so the
// copy handlers are fully synchronous — a network await between the click
// and clipboard.writeText() drops the browser's transient activation and
// the write silently fails.
// ═══════════════════════════════════════════════════════════

import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

// Robust clipboard write: the async Clipboard API where available, else a
// hidden-textarea + execCommand fallback (older browsers / insecure origins).
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
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

  const photoApi = (type === 'internal' ? internalCandidatesApi : externalCandidatesApi) as unknown as PhotoApi;
  const shareKey = [type, candidateId, 'photo-share-link'];
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [type, candidateId] });
    qc.invalidateQueries({ queryKey: shareKey });
  };

  // Eagerly resolve the public link so copying is synchronous.
  const shareQuery = useQuery({
    queryKey: shareKey,
    queryFn: () => photoApi.photoShareLink(candidateId),
    enabled: !!photoUrl,
    staleTime: 10 * 60 * 1000,
    retry: 2, // survive a cold-start / transient 5xx instead of caching the error
  });
  const shareUrl = photoUrl ? (shareQuery.data?.url ?? null) : null;

  const upload = useMutation({
    mutationFn: (file: File) => photoApi.uploadPhoto(candidateId, file),
    onSuccess: () => { toast.success('התמונה עודכנה'); invalidate(); },
    onError: (e) => toast.error('העלאת התמונה נכשלה', (e as Error).message),
  });

  const remove = useMutation({
    mutationFn: () => photoApi.removePhoto(candidateId),
    onSuccess: () => { toast.success('התמונה הוסרה'); invalidate(); },
    onError: (e) => toast.error('ההסרה נכשלה', (e as Error).message),
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
    const ok = await writeClipboard(text);
    if (ok) toast.success(label);
    else toast.error('ההעתקה נכשלה', 'העתק ידנית מהשדה');
  };

  const copyCard = () => void copy(cardText, 'הכרטיס הועתק');
  const copyLink = () => shareUrl && void copy(shareUrl, 'הלינק הועתק');

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

        {/* Clickable link preview (only when a photo + link exist) */}
        {photoUrl && shareUrl && (
          <a
            href={shareUrl}
            target="_blank"
            rel="noreferrer"
            title={shareUrl}
            className="block truncate rounded-md border border-border bg-bg-subtle px-2 py-1 text-xs text-brand hover:underline"
          >
            {shareUrl}
          </a>
        )}
        {photoUrl && shareQuery.isFetching && !shareUrl && <p className="text-xs text-ink-faint">טוען לינק…</p>}
        {photoUrl && !shareQuery.isFetching && !shareUrl && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-600">יצירת הלינק נכשלה.</span>
            <Button size="sm" variant="ghost" onClick={() => shareQuery.refetch()}>נסה שוב</Button>
          </div>
        )}

        {/* Two clear actions: the photo link, and the card text. */}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Link2 className="h-4 w-4" />}
            disabled={!shareUrl}
            onClick={copyLink}
          >
            העתק לינק
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Copy className="h-4 w-4" />}
            onClick={copyCard}
          >
            העתק כרטיס
          </Button>
          {photoUrl && shareUrl && (
            <Button
              size="sm"
              variant="ghost"
              leftIcon={<ExternalLink className="h-4 w-4" />}
              onClick={() => window.open(shareUrl, '_blank', 'noopener')}
            >
              פתח תמונה
            </Button>
          )}
        </div>
      </div>

      <input ref={inputRef} type="file" accept={ACCEPT.join(',')} className="hidden" onChange={onPick} />
    </div>
  );
}
