// ═══════════════════════════════════════════════════════════
// ShadchanAI — Object Storage (Cloudflare R2)
//
// A thin, S3-compatible wrapper around Cloudflare R2 used to durably
// store candidate photos. Render's local disk is ephemeral (wiped every
// deploy), so photos kept only under WA_MEDIA_DIR vanish on redeploy —
// this service is the durable home for them.
//
// Design mirrors the AI/embeddings providers: when R2 is not fully
// configured (env.r2Enabled === false) EVERY call is a graceful no-op /
// null, and callers fall back to local disk. Nothing here throws just
// because credentials are absent — only real network/permission faults do.
//
// Keys are lifecycle-foldered by the caller, e.g.
//   candidates/external/<id>.jpg · review/internal/<id>.jpg · junk/...
// ═══════════════════════════════════════════════════════════

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { env, r2Enabled } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('storage');

// A single lazily-built client. R2 exposes one global endpoint per account;
// region must be the literal 'auto'.
let client: S3Client | null = null;
function getClient(): S3Client | null {
  if (!r2Enabled) return null;
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
      },
    });
  }
  return client;
}

export function isStorageEnabled(): boolean {
  return r2Enabled;
}

/** Upload (overwrite) an object. Returns false when storage is disabled. */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  await c.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET as string,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  log.info({ key, bytes: body.length }, 'r2_put');
  return true;
}

/** Fetch an object's bytes + content-type, or null when missing / disabled. */
export async function getObject(
  key: string,
): Promise<{ data: Buffer; contentType: string } | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const res = await c.send(
      new GetObjectCommand({ Bucket: env.R2_BUCKET as string, Key: key }),
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) return null;
    return {
      data: Buffer.from(bytes),
      contentType: res.ContentType ?? 'application/octet-stream',
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** True if the object exists. False when missing or storage disabled. */
export async function objectExists(key: string): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    await c.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET as string, Key: key }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** Delete an object. Silently succeeds when already absent / disabled. */
export async function deleteObject(key: string): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  await c.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET as string, Key: key }));
  log.info({ key }, 'r2_delete');
  return true;
}

/**
 * Move an object (copy then delete source). Used once per lifecycle
 * transition (review → candidates/junk), never on the hot path. No-op when
 * source === dest. Returns false when disabled or the source is missing.
 */
export async function moveObject(fromKey: string, toKey: string): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  if (fromKey === toKey) return true;
  const bucket = env.R2_BUCKET as string;
  try {
    await c.send(
      new CopyObjectCommand({
        Bucket: bucket,
        // CopySource must be URL-encoded and bucket-prefixed.
        CopySource: `/${bucket}/${encodeURIComponent(fromKey)}`,
        Key: toKey,
      }),
    );
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
  await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
  log.info({ fromKey, toKey }, 'r2_move');
  return true;
}

/** List keys under a prefix (used by the junk cleanup job). */
export async function listObjects(
  prefix: string,
): Promise<Array<{ key: string; lastModified?: Date }>> {
  const c = getClient();
  if (!c) return [];
  const out: Array<{ key: string; lastModified?: Date }> = [];
  let token: string | undefined;
  do {
    const res = (await c.send(
      new ListObjectsV2Command({
        Bucket: env.R2_BUCKET as string,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    )) as ListObjectsV2CommandOutput;
    for (const obj of res.Contents ?? []) {
      if (obj.Key) out.push({ key: obj.Key, lastModified: obj.LastModified });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

// R2/S3 signals a missing object with a 404 or the NoSuchKey/NotFound codes.
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.$metadata?.httpStatusCode === 404
  );
}
