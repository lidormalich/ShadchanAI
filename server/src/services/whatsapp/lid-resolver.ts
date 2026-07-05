// ═══════════════════════════════════════════════════════════
// ShadchanAI — LID → Phone Resolver
//
// WhatsApp's privacy rollout replaces group senders' phone jids
// with anonymous "…@lid" ids, so key.participant no longer tells
// us who posted. Group METADATA, however, still lists each
// participant with both their lid and their real phone jid
// (whenever WhatsApp shares it) — this service fetches that
// list, caches it per group, and translates lids to phones.
//
// On the first successful resolution of a group it also repairs
// rows persisted while the lid was unresolvable: group messages
// missing senderPhone (the lid survives in rawPayload) and the
// external candidates derived from them.
// ═══════════════════════════════════════════════════════════

import type { GroupMetadata } from '@whiskeysockets/baileys';
import { Message, ExternalCandidate, type IChannel } from '../../models/index.js';
import { jidToPhone, jidToPhoneStrict } from './providers/baileys/baileys.mapper.js';
import { logWhatsApp, maskPhone } from './whatsapp.logger.js';

/** The only socket capability we need — keeps tests trivial. */
export interface GroupMetadataFetcher {
  groupMetadata(jid: string): Promise<GroupMetadata>;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // metadata is stable; refresh twice a shift
const MISS_RETRY_MS = 5 * 60 * 1000; // unknown lid may be a member who just joined

interface CacheEntry {
  fetchedAt: number;
  /** lid local digits → phone digits */
  lidToPhone: Map<string, string>;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry | null>>();
const repairedGroups = new Set<string>();

/** Test hook — resets module state between test cases. */
export function _resetLidResolver(): void {
  cache.clear();
  inFlight.clear();
  repairedGroups.clear();
}

function buildLidMap(meta: GroupMetadata): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of meta.participants ?? []) {
    const lidJid = p.id?.endsWith('@lid') ? p.id : p.lid;
    const phoneJid = p.jid ?? (p.id?.endsWith('@s.whatsapp.net') ? p.id : undefined);
    const phone = jidToPhoneStrict(phoneJid);
    if (lidJid && phone) map.set(jidToPhone(lidJid), phone);
  }
  return map;
}

async function getGroupEntry(
  sock: GroupMetadataFetcher,
  channel: IChannel,
  groupJid: string,
  wantedLidLocal: string,
): Promise<CacheEntry | null> {
  const key = `${channel.channelId}:${groupJid}`;
  const existing = cache.get(key);
  const age = existing ? Date.now() - existing.fetchedAt : Infinity;
  const isFresh = existing !== undefined
    && (existing.lidToPhone.has(wantedLidLocal) ? age < CACHE_TTL_MS : age < MISS_RETRY_MS);
  if (existing && isFresh) return existing;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const fetch = (async (): Promise<CacheEntry | null> => {
    try {
      const meta = await sock.groupMetadata(groupJid);
      const entry: CacheEntry = { fetchedAt: Date.now(), lidToPhone: buildLidMap(meta) };
      cache.set(key, entry);
      return entry;
    } catch (err) {
      logWhatsApp({
        event: 'error',
        channelId: channel.channelId,
        channelRole: channel.role,
        errorMessage: `lid-resolver groupMetadata(${groupJid}): ${(err as Error).message}`,
      });
      return existing ?? null; // stale beats nothing
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, fetch);
  return fetch;
}

/**
 * Resolve an anonymous "…@lid" group sender to their real phone.
 * Returns '' when WhatsApp doesn't share the phone (privacy setting)
 * or metadata is unavailable. Never throws.
 */
export async function resolveLidToPhone(
  sock: GroupMetadataFetcher,
  channel: IChannel,
  groupJid: string,
  lidJid: string,
): Promise<string> {
  if (!lidJid.endsWith('@lid') || !groupJid.endsWith('@g.us')) return '';
  const lidLocal = jidToPhone(lidJid);
  const entry = await getGroupEntry(sock, channel, groupJid, lidLocal);
  if (!entry) return '';

  const phone = entry.lidToPhone.get(lidLocal) ?? '';
  if (phone) {
    // Best-effort: rows stored while this group's lids were unresolvable
    // can now be healed. Once per group per process; runs detached.
    const repairKey = `${channel.channelId}:${groupJid}`;
    if (!repairedGroups.has(repairKey)) {
      repairedGroups.add(repairKey);
      void repairStoredLidRows(channel, groupJid, entry.lidToPhone).catch((err) => {
        logWhatsApp({
          event: 'error',
          channelId: channel.channelId,
          channelRole: channel.role,
          errorMessage: `lid-resolver repair(${groupJid}): ${(err as Error).message}`,
        });
      });
    }
  }
  return phone;
}

/** Pull the sender lid out of a stored rawPayload (live or history-sync shape). */
function lidFromRawPayload(rawPayload: unknown): string {
  if (!rawPayload || typeof rawPayload !== 'object') return '';
  const rp = rawPayload as Record<string, unknown>;
  const key = rp['key'];
  const fromKey = key && typeof key === 'object'
    ? (key as Record<string, unknown>)['participant']
    : undefined;
  const candidate = (typeof fromKey === 'string' ? fromKey : undefined)
    ?? (typeof rp['participant'] === 'string' ? (rp['participant'] as string) : undefined)
    ?? /"participant"\s*:\s*"([^"]+@lid)"/.exec(
      typeof rp['_preview'] === 'string' ? (rp['_preview'] as string) : '',
    )?.[1];
  return candidate?.endsWith('@lid') ? candidate : '';
}

/**
 * Backfill senderPhone on already-persisted group messages whose sender
 * arrived as a now-resolvable lid, then re-derive sourceSenderPhone on
 * external candidates sourced from this group.
 */
export async function repairStoredLidRows(
  channel: IChannel,
  groupJid: string,
  lidToPhone: Map<string, string>,
): Promise<void> {
  const messages = await Message.find({
    chatJid: groupJid,
    direction: 'inbound',
    senderPhone: { $exists: false },
  })
    .select('+rawPayload')
    .lean()
    .exec();

  let healedMessages = 0;
  for (const m of messages as unknown as Array<{ _id: unknown; rawPayload?: unknown }>) {
    const lid = lidFromRawPayload(m.rawPayload);
    if (!lid) continue;
    const phone = lidToPhone.get(jidToPhone(lid));
    if (!phone) continue;
    await Message.updateOne({ _id: m._id }, { $set: { senderPhone: phone } }).exec();
    healedMessages++;
  }

  let healedCandidates = 0;
  if (healedMessages > 0) {
    const candidates = await ExternalCandidate.find({
      sourceChatJid: groupJid,
      sourceSenderPhone: { $exists: false },
      sourceMessageIds: { $exists: true, $ne: [] },
    })
      .select('sourceMessageIds')
      .lean()
      .exec();

    for (const c of candidates as unknown as Array<{ _id: unknown; sourceMessageIds: unknown[] }>) {
      const src = await Message.findOne({
        _id: { $in: c.sourceMessageIds },
        senderPhone: { $exists: true, $ne: '' },
      })
        .select('senderPhone')
        .sort({ createdAt: 1 })
        .lean()
        .exec();
      const phone = (src as { senderPhone?: string } | null)?.senderPhone;
      if (!phone) continue;
      await ExternalCandidate.updateOne(
        { _id: c._id },
        { $set: { sourceSenderPhone: phone } },
      ).exec();
      healedCandidates++;
    }
  }

  if (healedMessages > 0 || healedCandidates > 0) {
    logWhatsApp({
      event: 'lid_repair',
      channelId: channel.channelId,
      channelRole: channel.role,
      participantPhoneMasked: maskPhone(groupJid),
      healedMessages,
      healedCandidates,
    });
  }
}
