// ═══════════════════════════════════════════════════════════
// ShadchanAI — Photo Storage Maintenance
//
// Periodic, idempotent upkeep for the R2 candidate-photo pipeline. Whole
// thing is a no-op when R2 is unconfigured. Three phases, each capped so a
// single run stays cheap:
//
//   1. Backfill — external candidates that have a WhatsApp source image on
//      disk but no R2 copy yet are mirrored to R2.
//   2. Reconcile — a candidate whose lifecycle changed (e.g. active →
//      archived) has its object moved to the matching folder, once.
//   3. Junk sweep — objects under junk/ older than the retention window are
//      deleted and the candidate's photo fields cleared.
// ═══════════════════════════════════════════════════════════

import type { Model } from 'mongoose';
import { InternalCandidate, ExternalCandidate, Message } from '../../models/index.js';
import { env } from '../../config/env.js';
import { readMediaFile, incomingPhotoKey } from '../whatsapp/media.service.js';
import { isStorageEnabled, listObjects, deleteObject, getObject } from './storage.service.js';
import {
  syncCandidatePhoto,
  reconcileCandidatePhotoFolder,
  parsePhotoKey,
  photoLifecycle,
  type LifecycleInput,
  type PhotoOwnerType,
} from './candidate-photo.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('photo-maintenance');

const BACKFILL_LIMIT = 25;
const RECONCILE_LIMIT = 50;

export interface PhotoMaintenanceSummary {
  backfilled: number;
  reconciled: number;
  junkDeleted: number;
  incomingSwept: number;
}

export async function runPhotoStorageMaintenance(): Promise<PhotoMaintenanceSummary | null> {
  if (!isStorageEnabled()) return null;
  const backfilled = await backfillExternalPhotos();
  const reconciled = await reconcileFolders();
  const junkDeleted = await sweepJunk();
  const incomingSwept = await sweepIncoming();
  const summary = { backfilled, reconciled, junkDeleted, incomingSwept };
  if (backfilled || reconciled || junkDeleted || incomingSwept) {
    log.info({ ...summary }, 'photo_maintenance_done');
  }
  return summary;
}

// ── 1. Backfill external photos from the on-disk WhatsApp image ──
async function backfillExternalPhotos(): Promise<number> {
  const pending = await ExternalCandidate.find({
    photoStorageKey: { $exists: false },
    sourceMessageIds: { $exists: true, $ne: [] },
  })
    .select('_id status archivedAt sourceMessageIds')
    .limit(BACKFILL_LIMIT)
    .exec();

  let done = 0;
  for (const cand of pending) {
    const ids = (cand.sourceMessageIds ?? []).map(String);
    if (ids.length === 0) continue;
    // Newest source message with a stored image wins.
    const msg = await Message.findOne({
      _id: { $in: ids },
      contentType: 'image',
      mediaUrl: { $exists: true },
    })
      .sort({ createdAt: -1 })
      .select('mediaUrl')
      .lean()
      .exec();
    const filename = msg?.mediaUrl?.split('/').pop();
    if (!filename) continue;
    // Prefer the local disk copy; fall back to the durable R2 mirror written
    // at download time (disk may have been wiped by a deploy since then).
    let bytes: Buffer | null = null;
    const disk = await readMediaFile(filename);
    if (disk) bytes = disk.data;
    else {
      const mirrored = await getObject(incomingPhotoKey(filename));
      if (mirrored) bytes = mirrored.data;
    }
    if (!bytes) continue;
    const ext = filename.split('.').pop() ?? 'jpg';

    const res = await syncCandidatePhoto({
      type: 'external',
      id: String(cand._id),
      lifecycleInput: { type: 'external', status: cand.status, archivedAt: cand.archivedAt ?? null },
      data: bytes,
      ext,
    });
    if (res.ok && res.storageKey) {
      cand.photoUrl = res.proxyUrl;
      cand.photoStorageKey = res.storageKey;
      await cand.save();
      // The bytes now live under the candidate's key — drop the incoming copy.
      await deleteObject(incomingPhotoKey(filename)).catch(() => undefined);
      done++;
    }
  }
  return done;
}

// ── 2. Reconcile folders for candidates whose lifecycle moved ──
async function reconcileFolders(): Promise<number> {
  let moved = 0;
  moved += await reconcileFor('external', ExternalCandidate);
  moved += await reconcileFor('internal', InternalCandidate);
  return moved;
}

async function reconcileFor(
  type: PhotoOwnerType,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any,
): Promise<number> {
  const docs = await model
    .find({ photoStorageKey: { $exists: true } })
    .select('_id status archivedAt photoApproved photoStorageKey')
    .limit(RECONCILE_LIMIT)
    .exec();

  let moved = 0;
  for (const cand of docs) {
    const key: string = cand.photoStorageKey;
    const parsed = parsePhotoKey(key);
    if (!parsed) continue;
    const lifecycleInput: LifecycleInput = {
      type,
      status: cand.status,
      archivedAt: cand.archivedAt ?? null,
      photoApproved: cand.photoApproved,
    };
    if (parsed.lifecycle === photoLifecycle(lifecycleInput)) continue;
    const r = await reconcileCandidatePhotoFolder({
      type,
      id: String(cand._id),
      currentStorageKey: key,
      lifecycleInput,
    });
    if (r.moved) {
      cand.photoStorageKey = r.storageKey;
      await cand.save();
      moved++;
    }
  }
  return moved;
}

// ── 4. Delete incoming/ raw mirrors that never became a candidate ──
// A download-time mirror is deleted the moment its candidate photo is
// synced. What lingers here is orphaned raw images (non-profile photos,
// messages that never produced a candidate). Sweep them on the same
// retention window so the mirror bucket doesn't grow unbounded.
async function sweepIncoming(): Promise<number> {
  if (env.R2_JUNK_RETENTION_DAYS <= 0) return 0;
  const cutoff = Date.now() - env.R2_JUNK_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const objects = await listObjects('incoming/');
  let deleted = 0;
  for (const obj of objects) {
    if (!obj.lastModified || obj.lastModified.getTime() > cutoff) continue;
    await deleteObject(obj.key);
    deleted++;
  }
  return deleted;
}

// ── 3. Delete junk/ objects past the retention window ──
async function sweepJunk(): Promise<number> {
  if (env.R2_JUNK_RETENTION_DAYS <= 0) return 0;
  const cutoff = Date.now() - env.R2_JUNK_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const objects = await listObjects('junk/');
  let deleted = 0;
  for (const obj of objects) {
    if (!obj.lastModified || obj.lastModified.getTime() > cutoff) continue;
    await deleteObject(obj.key);
    // Clear the candidate's dangling photo pointer so the UI stops linking it.
    const parsed = parsePhotoKey(obj.key);
    if (parsed) {
      const model = (parsed.type === 'internal' ? InternalCandidate : ExternalCandidate) as Model<unknown>;
      await model
        .updateOne(
          { _id: parsed.id, photoStorageKey: obj.key },
          { $unset: { photoUrl: '', photoStorageKey: '' } },
        )
        .exec()
        .catch(() => undefined);
    }
    deleted++;
  }
  return deleted;
}
