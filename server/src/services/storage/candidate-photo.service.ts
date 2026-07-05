// ═══════════════════════════════════════════════════════════
// ShadchanAI — Candidate Photo Pipeline
//
// Mirrors each candidate's photo to durable R2 storage under a
// lifecycle-folder key and serves it back (auth-gated) via the media
// proxy. The single source of truth for "which folder" is
// photoLifecycle() below — change the mapping there and everything
// (upload target, folder reconcile, junk cleanup) follows.
//
// Layout:
//   candidates/<type>/<id>.<ext>   valid, active candidate
//   review/<type>/<id>.<ext>       needs human confirmation
//   junk/<type>/<id>.<ext>         rejected — deleted after retention
//
// Stable key: the exact key is persisted on the candidate as
// photoStorageKey, so serving never has to guess the extension or folder.
// A candidate only changes folder on a real lifecycle transition, handled
// once by reconcileCandidatePhotoFolder() (copy+delete), never on the hot
// serving path.
// ═══════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import { getObject, putObject, moveObject, deleteObject, isStorageEnabled } from './storage.service.js';
import { MIME_BY_EXT } from '../whatsapp/media.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('candidate-photo');

export type PhotoOwnerType = 'internal' | 'external';
export type PhotoLifecycle = 'candidates' | 'review' | 'junk';

// Minimal shape needed to decide a candidate's photo lifecycle folder.
export interface LifecycleInput {
  status?: string;
  archivedAt?: Date | null;
  // internal-only: an unapproved photo is treated as "in review".
  photoApproved?: boolean;
  type: PhotoOwnerType;
}

/**
 * THE mapping from candidate state → storage folder. This is the one place
 * to tune when the review/approval model changes.
 *
 *   archived / explicitly archivedAt        → junk   (auto-deleted later)
 *   external stale|unavailable              → review (needs re-confirmation)
 *   internal photo not yet approved         → review
 *   everything else (active/paused/dating…) → candidates
 */
export function photoLifecycle(c: LifecycleInput): PhotoLifecycle {
  if (c.status === 'archived' || c.archivedAt) return 'junk';
  if (c.type === 'external' && (c.status === 'stale' || c.status === 'unavailable')) {
    return 'review';
  }
  if (c.type === 'internal' && c.photoApproved === false) return 'review';
  return 'candidates';
}

const EXT_RE = /\.(jpg|png|webp)$/i;

export function photoKey(
  type: PhotoOwnerType,
  lifecycle: PhotoLifecycle,
  id: string,
  ext: string,
): string {
  const clean = ext.replace(/^\./, '').toLowerCase();
  return `${lifecycle}/${type}/${id}.${clean}`;
}

/** The stable, auth-gated URL stored on candidate.photoUrl for the client. */
export function photoProxyUrl(type: PhotoOwnerType, id: string): string {
  return `/api/media/candidate/${type}/${id}`;
}

/** Random, unguessable token for a PUBLIC (no-auth) photo share link. */
export function generatePhotoShareToken(): string {
  return crypto.randomBytes(24).toString('base64url'); // ~32 url-safe chars
}

/** Absolute public URL for a share token, e.g. https://host/api/public/photo/<token>. */
export function buildPublicPhotoUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/api/public/photo/${token}`;
}

/** Parse "candidates/external/<id>.jpg" → its parts (for cleanup jobs). */
export function parsePhotoKey(
  key: string,
): { lifecycle: PhotoLifecycle; type: PhotoOwnerType; id: string } | null {
  const m = key.match(/^(candidates|review|junk)\/(internal|external)\/([a-f0-9]{24})\.(jpg|png|webp)$/);
  if (!m) return null;
  return { lifecycle: m[1] as PhotoLifecycle, type: m[2] as PhotoOwnerType, id: m[3] as string };
}

export interface SyncResult {
  ok: boolean;
  reason?: string;
  storageKey?: string;
  proxyUrl?: string;
}

/**
 * Upload a candidate's photo bytes to R2 at its current lifecycle key.
 * Returns the storageKey + proxyUrl the caller persists on the candidate.
 * No-op (ok:false, reason:'storage_disabled') when R2 isn't configured.
 */
export async function syncCandidatePhoto(params: {
  type: PhotoOwnerType;
  id: string;
  lifecycleInput: LifecycleInput;
  data: Buffer;
  ext: string; // jpg | png | webp
}): Promise<SyncResult> {
  if (!isStorageEnabled()) return { ok: false, reason: 'storage_disabled' };
  const { type, id, data } = params;
  const ext = params.ext.replace(/^\./, '').toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? 'image/jpeg';
  const lifecycle = photoLifecycle(params.lifecycleInput);
  const key = photoKey(type, lifecycle, id, ext);
  try {
    await putObject(key, data, contentType);
  } catch (err) {
    log.warn({ type, id, err: (err as Error).message }, 'photo_sync_failed');
    return { ok: false, reason: (err as Error).message };
  }
  return { ok: true, storageKey: key, proxyUrl: photoProxyUrl(type, id) };
}

/** Read a candidate's stored photo bytes for the serving proxy. */
export async function readCandidatePhoto(
  storageKey: string,
): Promise<{ data: Buffer; contentType: string } | null> {
  if (!isStorageEnabled()) return null;
  if (!EXT_RE.test(storageKey)) return null;
  return getObject(storageKey);
}

/**
 * Ensure the object lives under the folder matching the candidate's CURRENT
 * lifecycle. Runs only on real transitions (copy+delete once), never on the
 * hot path. Returns the new key when it moved, or the same key otherwise.
 */
export async function reconcileCandidatePhotoFolder(params: {
  type: PhotoOwnerType;
  id: string;
  currentStorageKey: string;
  lifecycleInput: LifecycleInput;
}): Promise<{ moved: boolean; storageKey: string }> {
  const { type, id, currentStorageKey } = params;
  const parsed = parsePhotoKey(currentStorageKey);
  if (!parsed || !isStorageEnabled()) return { moved: false, storageKey: currentStorageKey };
  const desired = photoLifecycle(params.lifecycleInput);
  if (parsed.lifecycle === desired) return { moved: false, storageKey: currentStorageKey };
  const ext = currentStorageKey.match(EXT_RE)?.[1] ?? 'jpg';
  const toKey = photoKey(type, desired, id, ext);
  const ok = await moveObject(currentStorageKey, toKey);
  if (!ok) return { moved: false, storageKey: currentStorageKey };
  log.info({ type, id, from: parsed.lifecycle, to: desired }, 'photo_folder_reconciled');
  return { moved: true, storageKey: toKey };
}

/** Delete a candidate's stored photo outright (e.g. on hard delete). */
export async function deleteCandidatePhoto(storageKey: string): Promise<void> {
  if (!isStorageEnabled()) return;
  await deleteObject(storageKey).catch(() => undefined);
}
