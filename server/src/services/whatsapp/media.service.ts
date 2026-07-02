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
import { createLogger } from '../../utils/logger.js';

const log = createLogger('wa-media');

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
