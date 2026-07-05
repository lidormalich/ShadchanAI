// ═══════════════════════════════════════════════════════════
// ShadchanAI — WhatsApp Media Service
//
// Downloads inbound media (images — the dominant profile-card format
// in shidduch groups) at receive time, stores it on the persistent
// disk, and serves it back via /api/media/<file>.
//
// Why at receive time: WhatsApp media is fetched with per-message
// media keys that EXPIRE. A "later" fetch job routinely finds dead
// keys, which is how image cards used to vanish entirely.
//
// Scope (v1): images only. Video/audio/documents are stored as
// metadata-only messages exactly as before.
// ═══════════════════════════════════════════════════════════

import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadContentFromMessage, normalizeMessageContent } from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';
import { Message } from '../../models/index.js';
import { env } from '../../config/env.js';
import { isStorageEnabled, putObject } from '../storage/storage.service.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('wa-media');

// Durable R2 key for a freshly-received image, BEFORE it's tied to a
// candidate. Mirrored at download time so the bytes survive Render's
// ephemeral disk even if a deploy wipes it before the candidate exists.
// The candidate-photo backfill reads from here when the disk file is gone.
export function incomingPhotoKey(filename: string): string {
  return `incoming/${filename}`;
}

// Protobuf byte fields (mediaKey, fileEncSha256, …) survive a Mongo round-trip
// as BSON Binary or a serialized-Buffer shape, NOT a Node Buffer. Baileys needs
// real Uint8Arrays to decrypt media, so convert them back. Handles: real
// Buffer/Uint8Array (pass through), BSON Binary ({ buffer, position, sub_type }
// or a Binary instance with .buffer/.value()), and { type:'Buffer', data:[…] }.
function toUint8Array(v: unknown): Uint8Array | undefined {
  if (v == null) return undefined;
  if (v instanceof Uint8Array) return v; // includes Node Buffer
  const o = v as Record<string, unknown> & { value?: (asRaw?: boolean) => unknown };
  // Node Buffer JSON form.
  if (o['type'] === 'Buffer' && Array.isArray(o['data'])) return Buffer.from(o['data'] as number[]);
  // BSON Binary as a plain object (comes back this way under .lean()).
  if (o['buffer'] != null) {
    const buf = o['buffer'];
    const base = Buffer.isBuffer(buf) || buf instanceof Uint8Array ? Buffer.from(buf as Uint8Array) : Buffer.from(buf as never);
    return typeof o['position'] === 'number' ? base.subarray(0, o['position'] as number) : base;
  }
  // BSON Binary instance with a value() accessor.
  if (typeof o.value === 'function') {
    const raw = o.value(true);
    if (raw instanceof Uint8Array) return raw;
    if (Buffer.isBuffer(raw)) return raw;
  }
  return undefined;
}

const MEDIA_BINARY_FIELDS = [
  'mediaKey',
  'fileEncSha256',
  'fileSha256',
  'streamingSidecar',
  'midQualityFileEncSha256',
  'midQualityFileSha256',
] as const;

function restoreMediaBinaries(node: Record<string, unknown>): void {
  for (const field of MEDIA_BINARY_FIELDS) {
    if (node[field] == null) continue;
    const restored = toUint8Array(node[field]);
    if (restored) node[field] = restored;
  }
}

// Filename shape is fully derived from trusted values (Mongo _id + mapped
// extension), and the serving router re-validates against this pattern —
// path traversal is structurally impossible.
export const MEDIA_FILENAME_RE = /^[a-f0-9]{24}\.(jpg|png|webp)$/;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

let dirReady = false;
async function ensureMediaDir(): Promise<string> {
  const dir = path.resolve(env.WA_MEDIA_DIR);
  if (!dirReady) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    dirReady = true;
  }
  return dir;
}

export function mediaFilePath(filename: string): string | null {
  if (!MEDIA_FILENAME_RE.test(filename)) return null;
  return path.join(path.resolve(env.WA_MEDIA_DIR), filename);
}

/**
 * Download the image referenced by a persisted inbound message and store
 * it on disk; sets message.mediaUrl on success. Idempotent — a message
 * that already has a mediaUrl (or a file on disk) is a fast no-op, so the
 * ingest fire-and-forget, the reconciler retry, and an on-demand call
 * from vision extraction can all race safely.
 */
export async function downloadInboundMedia(
  messageId: string,
): Promise<{ ok: boolean; reason?: string; filename?: string }> {
  const message = await Message.findById(messageId)
    .select('+rawPayload contentType mediaUrl mediaMimeType')
    .exec();
  if (!message) return { ok: false, reason: 'message_not_found' };
  if (message.contentType !== 'image') return { ok: false, reason: 'not_image' };
  if (message.mediaUrl) {
    return { ok: true, filename: message.mediaUrl.split('/').pop() };
  }

  // Recover the imageMessage node (media key + directPath) from the raw
  // provider payload. Envelope wrappers (ephemeral / view-once) are
  // unwrapped the same way the mapper does.
  const raw = message.rawPayload as { message?: proto.IMessage; _truncated?: boolean } | undefined;
  if (!raw?.message) {
    return { ok: false, reason: raw?._truncated ? 'raw_payload_truncated' : 'no_raw_payload' };
  }
  const content = normalizeMessageContent(raw.message);
  const imageMessage = content?.imageMessage;
  if (!imageMessage) return { ok: false, reason: 'no_image_node' };

  // Storing rawPayload in Mongo turns every protobuf Buffer field into a BSON
  // Binary ({sub_type, buffer, position}) that does NOT come back as a Node
  // Buffer. Baileys' AES media decrypt then derives keys from a garbage
  // mediaKey and fails with "bad decrypt" on EVERY download (receive,
  // reconciler, extraction all read from Mongo). Coerce the binary fields
  // back to real Buffers before handing the node to downloadContentFromMessage.
  restoreMediaBinaries(imageMessage as unknown as Record<string, unknown>);

  const ext = EXT_BY_MIME[imageMessage.mimetype ?? message.mediaMimeType ?? ''] ?? 'jpg';
  const filename = `${String(message._id)}.${ext}`;

  try {
    const dir = await ensureMediaDir();
    const filePath = path.join(dir, filename);

    // Already on disk (previous attempt died between write and save).
    const exists = await fs.stat(filePath).then(() => true).catch(() => false);
    if (!exists) {
      const stream = await downloadContentFromMessage(imageMessage, 'image');
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > env.WA_MEDIA_MAX_BYTES) {
          return { ok: false, reason: 'media_too_large' };
        }
        chunks.push(buf);
      }
      await fs.writeFile(filePath, Buffer.concat(chunks), { mode: 0o600 });
    }

    message.mediaUrl = `/api/media/${filename}`;
    await message.save();
    log.info({ messageId, filename }, 'media_downloaded');

    // Mirror the raw bytes to durable R2 immediately (best-effort). Closes
    // the window where an image lives only on ephemeral disk between receive
    // and the candidate-photo backfill. Failure here never fails the download.
    if (isStorageEnabled()) {
      try {
        const bytes = await fs.readFile(filePath);
        await putObject(incomingPhotoKey(filename), bytes, MIME_BY_EXT[ext] ?? 'image/jpeg');
      } catch (mirrorErr) {
        log.warn({ messageId, err: (mirrorErr as Error).message }, 'media_r2_mirror_failed');
      }
    }
    return { ok: true, filename };
  } catch (err) {
    // Expired media keys / network faults — the reconciler retries while
    // the message is young AND under the attempt cap; after that the card
    // survives as caption-only. "bad decrypt" = the stored media key can
    // no longer decrypt the blob (WhatsApp rotates them fast) — those can
    // never succeed, which is exactly what the attempt cap is for.
    await Message.updateOne(
      { _id: message._id },
      { $inc: { mediaDownloadAttempts: 1 } },
    ).exec().catch(() => undefined);
    log.warn({ messageId, err: (err as Error).message }, 'media_download_failed');
    return { ok: false, reason: (err as Error).message };
  }
}

/** Read a stored media file for serving / vision extraction. */
export async function readMediaFile(
  filename: string,
): Promise<{ data: Buffer; mimeType: string } | null> {
  const filePath = mediaFilePath(filename);
  if (!filePath) return null;
  try {
    const data = await fs.readFile(filePath);
    const ext = filename.split('.').pop() ?? 'jpg';
    return { data, mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}
