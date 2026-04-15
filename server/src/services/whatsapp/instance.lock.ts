// Per-process ownership lock for Baileys channels.
// Prevents two processes from running the same WhatsApp session.

import crypto from 'node:crypto';
import { Channel } from '../../models/index.js';

export const INSTANCE_ID = process.env['INSTANCE_ID'] ?? crypto.randomUUID();

const STALE_MS = 60_000;

export async function acquireChannelLock(channelId: string): Promise<boolean> {
  const staleCutoff = new Date(Date.now() - STALE_MS);
  const res = await Channel.updateOne(
    {
      channelId,
      $or: [
        { ownerInstanceId: null },
        { ownerInstanceId: INSTANCE_ID },
        { ownerHeartbeatAt: { $lt: staleCutoff } },
      ],
    },
    { $set: { ownerInstanceId: INSTANCE_ID, ownerHeartbeatAt: new Date() } },
  ).exec();
  return res.matchedCount === 1;
}

export async function heartbeatChannelLock(channelId: string): Promise<void> {
  await Channel.updateOne(
    { channelId, ownerInstanceId: INSTANCE_ID },
    { $set: { ownerHeartbeatAt: new Date() } },
  ).exec();
}

export async function releaseChannelLock(channelId: string): Promise<void> {
  await Channel.updateOne(
    { channelId, ownerInstanceId: INSTANCE_ID },
    { $set: { ownerInstanceId: null } },
  ).exec();
}
