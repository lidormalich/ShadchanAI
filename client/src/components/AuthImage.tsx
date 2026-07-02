// ═══════════════════════════════════════════════════════════
// AuthImage — <img> for API media that requires the auth header.
// /api/media/:file rejects plain <img src>; this fetches the blob
// with the Bearer token, renders it via an object URL, and revokes
// the URL on unmount/src change. Loading → subtle skeleton, error →
// renders nothing.
// ═══════════════════════════════════════════════════════════

import { clsx } from 'clsx';
import { useEffect, useState } from 'react';
import { getAuthHeaders } from '@/services/api/client';

export function AuthImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    fetch(src, { headers: getAuthHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error(`media_fetch_failed_${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (failed) return null;
  if (!url) return <div className={clsx('skeleton rounded-md', className)} style={{ minHeight: 96 }} />;
  return <img src={url} alt={alt ?? ''} className={className} />;
}
