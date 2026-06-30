// ═══════════════════════════════════════════════════════════
// ShadchanAI — Baileys Session Store
//
// Persistent auth state per channel. Uses Baileys' built-in
// `useMultiFileAuthState` helper but scopes each channel to its
// own subdirectory so the N channels of a deployment can't clobber
// each other.
//
// Sensitive: the files contain the WhatsApp credentials.
//   - never log their contents
//   - 0600 permissions on the session dir recommended (we chmod on create)
//   - exclude from public backups or encrypt at rest
// ═══════════════════════════════════════════════════════════

// PARTIAL IMPLEMENTATION: WA_SESSION_ENCRYPTION_KEY gates offline backup
// helpers only. Live read/write remains plain (Baileys owns useMultiFileAuthState).
// Transparent at-rest encryption requires patching Baileys internals — deferred.
// Ops MUST rely on full-disk/volume encryption for the live session files.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import type { AuthenticationState } from '@whiskeysockets/baileys';
import { env } from '../../../../config/env.js';
import { BAILEYS } from '../../whatsapp.constants.js';
import { createLogger } from '../../../../utils/logger.js';

const log = createLogger('baileys.session.store');

if (!env.WA_SESSION_ENCRYPTION_KEY) {
  log.warn('wa_sessions_unencrypted');
}

export interface BaileysAuth {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export function sessionDirFor(channelId: string): string {
  return path.resolve(env.WA_SESSIONS_DIR, channelId);
}

/**
 * Load or create the Baileys auth state for a channel.
 * Ensures the directory exists with restrictive permissions.
 */
export async function loadAuth(channelId: string): Promise<BaileysAuth> {
  const dir = sessionDirFor(channelId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    /* best-effort — some FS don't support chmod */
  }
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  return { state, saveCreds };
}

/**
 * Wipe the on-disk session for a channel. Used when the user
 * explicitly logs out or when Baileys reports a credential
 * invalidation (403 / loggedOut). The channel record itself
 * is kept; only the secret material is purged.
 */
export async function purgeSession(channelId: string): Promise<void> {
  const dir = sessionDirFor(channelId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    // Swallow — purge must not throw from shutdown paths.
    log.error({ channelId, error: (err as Error).message }, 'purge failed');
  }
}

/**
 * Health check for the session directory (called by admin endpoints).
 * Returns { exists, fileCount } — NEVER the file contents.
 */
export async function sessionSummary(channelId: string): Promise<{
  exists: boolean;
  fileCount: number;
  sizeBytes: number;
}> {
  const dir = sessionDirFor(channelId);
  try {
    const entries = await fs.readdir(dir);
    let sizeBytes = 0;
    for (const name of entries) {
      try {
        const stat = await fs.stat(path.join(dir, name));
        sizeBytes += stat.size;
      } catch { /* file vanished between readdir and stat */ }
    }
    return { exists: true, fileCount: entries.length, sizeBytes };
  } catch {
    return { exists: false, fileCount: 0, sizeBytes: 0 };
  }
}

/** Exported for tests; pulls from constants so callers don't hard-code. */
export const DEFAULT_SESSION_FILE_MODE = BAILEYS.SESSION_FILE_MODE;

// ── Offline backup encryption (AES-256-GCM) ──────────────

function requireKey(): Buffer {
  const hex = env.WA_SESSION_ENCRYPTION_KEY;
  if (!hex) throw new Error('WA_SESSION_ENCRYPTION_KEY not set');
  return Buffer.from(hex, 'hex');
}

/** Encrypt a channel's session directory into <sessionDir>.enc and delete the plain dir. */
export async function encryptSessionDirectory(channelId: string): Promise<string> {
  const dir = sessionDirFor(channelId);
  const entries = await fs.readdir(dir);
  // Minimal tar-like concatenation: [name_len(4)][name][size(8)][bytes]...
  const chunks: Buffer[] = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    const stat = await fs.stat(full);
    if (!stat.isFile()) continue;
    const data = await fs.readFile(full);
    const nameBuf = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(12);
    head.writeUInt32BE(nameBuf.length, 0);
    head.writeBigUInt64BE(BigInt(data.length), 4);
    chunks.push(head, nameBuf, data);
  }
  const plain = Buffer.concat(chunks);
  const key = requireKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([iv, tag, enc]);
  const outPath = `${dir}.enc`;
  await fs.writeFile(outPath, out, { mode: 0o600 });
  await fs.rm(dir, { recursive: true, force: true });
  return outPath;
}

/** Decrypt a previously encrypted session archive back to the session directory. */
export async function decryptSessionDirectory(channelId: string): Promise<string> {
  const dir = sessionDirFor(channelId);
  const encPath = `${dir}.enc`;
  const blob = await fs.readFile(encPath);
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const body = blob.subarray(28);
  const key = requireKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  let off = 0;
  while (off < plain.length) {
    const nameLen = plain.readUInt32BE(off); off += 4;
    const size = Number(plain.readBigUInt64BE(off)); off += 8;
    const name = plain.subarray(off, off + nameLen).toString('utf8'); off += nameLen;
    const data = plain.subarray(off, off + size); off += size;
    await fs.writeFile(path.join(dir, name), data, { mode: 0o600 });
  }
  await fs.rm(encPath, { force: true });
  return dir;
}
