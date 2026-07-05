// One-off data repair for Message.senderPhone / ExternalCandidate
// .sourceSenderPhone rows written BEFORE the mapper stopped falling back
// to the chat jid: when a group message arrived without key.participant
// (or came from a channel/newsletter), senderPhone was stored as the
// GROUP's own id ("120363…") — which the UI then showed as "טלפון השולח".
//
// Repair strategy per message:
//   - Recompute the real sender from rawPayload.key.participantPn /
//     .participant (only jids that actually carry a phone count — group,
//     newsletter and anonymous "@lid" ids never do).
//   - If the stored senderPhone is the chat's own id → replace it with the
//     recovered phone, or unset it when nothing recoverable ("no phone" is
//     better than a misleading id).
//   - If senderPhone is missing but recoverable → backfill it.
//   - A stored value that already looks like a real phone is left alone.
// Then ExternalCandidate.sourceSenderPhone is re-derived from the (now
// repaired) source messages wherever it carries the group id or is empty.
//
// Usage:
//   npx tsx src/scripts/fix-sender-phones.ts          # dry run (default)
//   npx tsx src/scripts/fix-sender-phones.ts --fix    # apply
import dns from 'node:dns';
import type { Types } from 'mongoose';
import { connectDB, disconnectDB } from '../config/db.js';
import { Message, ExternalCandidate } from '../models/index.js';
import { jidToPhoneStrict } from '../services/whatsapp/providers/baileys/baileys.mapper.js';

// Same DNS pin as wa-diagnose — mongodb+srv:// SRV lookups can fail on
// some Windows setups with the default resolver.
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch { /* best-effort */ }

const APPLY = process.argv.includes('--fix');

// Chats whose jid-local part is NOT a phone: groups and channels.
const NON_PHONE_CHAT = /@(?:g\.us|newsletter)$/;

function jidLocal(jid: string): string {
  return (jid.split('@')[0] ?? '').split(':')[0] ?? '';
}

/** Best-effort real-sender phone out of a stored rawPayload. */
function recoverSenderPhone(rawPayload: unknown): string {
  if (!rawPayload || typeof rawPayload !== 'object') return '';
  const rp = rawPayload as Record<string, unknown>;

  const key = rp['key'];
  if (key && typeof key === 'object') {
    const k = key as Record<string, unknown>;
    const pn = typeof k['participantPn'] === 'string' ? k['participantPn'] : undefined;
    const p = typeof k['participant'] === 'string' ? k['participant'] : undefined;
    // History-sync messages carry the sender on the top-level participant
    // field instead of key.participant.
    const top = typeof rp['participant'] === 'string' ? (rp['participant'] as string) : undefined;
    return jidToPhoneStrict(pn ?? p ?? top);
  }

  // Oversized payloads were truncated to a JSON preview string — the key
  // block serializes first, so the participant usually survives in it.
  const preview = rp['_preview'];
  if (typeof preview === 'string') {
    const pn = /"participantPn"\s*:\s*"([^"]+)"/.exec(preview)?.[1];
    const p = /"participant"\s*:\s*"([^"]+)"/.exec(preview)?.[1];
    return jidToPhoneStrict(pn ?? p);
  }
  return '';
}

interface MessageRepairStats {
  scanned: number;
  recovered: number; // wrong id → real phone
  cleared: number;   // wrong id → unset
  backfilled: number; // empty → real phone
}

async function repairMessages(): Promise<MessageRepairStats> {
  const stats: MessageRepairStats = { scanned: 0, recovered: 0, cleared: 0, backfilled: 0 };

  const cursor = Message.find({
    direction: 'inbound',
    chatJid: { $regex: NON_PHONE_CHAT },
  })
    .select('senderPhone chatJid +rawPayload')
    .lean()
    .cursor();

  for await (const m of cursor) {
    stats.scanned++;
    const doc = m as unknown as {
      _id: Types.ObjectId;
      chatJid: string;
      senderPhone?: string;
      rawPayload?: unknown;
    };

    const stored = doc.senderPhone ?? '';
    const chatLocal = jidLocal(doc.chatJid);
    const storedIsChatId = stored !== '' && stored === chatLocal;
    const recovered = recoverSenderPhone(doc.rawPayload);

    if (storedIsChatId) {
      if (recovered) {
        stats.recovered++;
        if (APPLY) {
          await Message.updateOne({ _id: doc._id }, { $set: { senderPhone: recovered } }).exec();
        }
      } else {
        stats.cleared++;
        if (APPLY) {
          await Message.updateOne({ _id: doc._id }, { $unset: { senderPhone: 1 } }).exec();
        }
      }
    } else if (!stored && recovered) {
      stats.backfilled++;
      if (APPLY) {
        await Message.updateOne({ _id: doc._id }, { $set: { senderPhone: recovered } }).exec();
      }
    }
    // A stored value that isn't the chat id is assumed to be a real phone —
    // never overwrite it from here.
  }

  return stats;
}

interface CandidateRepairStats {
  scanned: number;
  recovered: number;
  cleared: number;
  backfilled: number;
}

async function repairCandidates(): Promise<CandidateRepairStats> {
  const stats: CandidateRepairStats = { scanned: 0, recovered: 0, cleared: 0, backfilled: 0 };

  const cursor = ExternalCandidate.find({
    sourceChatJid: { $regex: NON_PHONE_CHAT },
  })
    .select('sourceSenderPhone sourceChatJid sourceMessageIds')
    .lean()
    .cursor();

  for await (const c of cursor) {
    stats.scanned++;
    const doc = c as unknown as {
      _id: Types.ObjectId;
      sourceChatJid: string;
      sourceSenderPhone?: string;
      sourceMessageIds?: Types.ObjectId[];
    };

    const stored = doc.sourceSenderPhone ?? '';
    const storedIsChatId = stored !== '' && stored === jidLocal(doc.sourceChatJid);
    if (!storedIsChatId && stored !== '') continue; // plausible phone — leave alone

    // Re-derive from the source messages (already repaired in pass 1).
    // In dry-run mode messages are untouched, so recover from rawPayload
    // directly to report accurate numbers.
    let derived = '';
    const ids = doc.sourceMessageIds ?? [];
    if (ids.length) {
      const msgs = await Message.find({ _id: { $in: ids } })
        .select('senderPhone chatJid +rawPayload createdAt')
        .sort({ createdAt: 1 })
        .lean()
        .exec();
      for (const m of msgs as unknown as Array<{ senderPhone?: string; chatJid?: string; rawPayload?: unknown }>) {
        const sp = m.senderPhone ?? '';
        const good = sp !== '' && sp !== jidLocal(m.chatJid ?? '');
        derived = good ? sp : recoverSenderPhone(m.rawPayload);
        if (derived) break;
      }
    }

    if (storedIsChatId) {
      if (derived) {
        stats.recovered++;
        if (APPLY) {
          await ExternalCandidate.updateOne(
            { _id: doc._id },
            { $set: { sourceSenderPhone: derived } },
          ).exec();
        }
      } else {
        stats.cleared++;
        if (APPLY) {
          await ExternalCandidate.updateOne(
            { _id: doc._id },
            { $unset: { sourceSenderPhone: 1 } },
          ).exec();
        }
      }
    } else if (!stored && derived) {
      stats.backfilled++;
      if (APPLY) {
        await ExternalCandidate.updateOne(
          { _id: doc._id },
          { $set: { sourceSenderPhone: derived } },
        ).exec();
      }
    }
  }

  return stats;
}

async function main(): Promise<void> {
  await connectDB();

  console.log(`\nMode: ${APPLY ? 'FIX (writing)' : 'DRY RUN (pass --fix to apply)'}\n`);

  const msgStats = await repairMessages();
  console.log('── Messages (group/channel chats)');
  console.log(`   scanned:    ${msgStats.scanned}`);
  console.log(`   recovered:  ${msgStats.recovered}  (group-id → real phone from rawPayload)`);
  console.log(`   cleared:    ${msgStats.cleared}  (group-id → removed, no phone recoverable)`);
  console.log(`   backfilled: ${msgStats.backfilled}  (empty → real phone from rawPayload)\n`);

  const candStats = await repairCandidates();
  console.log('── ExternalCandidates (sourceSenderPhone)');
  console.log(`   scanned:    ${candStats.scanned}`);
  console.log(`   recovered:  ${candStats.recovered}`);
  console.log(`   cleared:    ${candStats.cleared}`);
  console.log(`   backfilled: ${candStats.backfilled}`);

  await disconnectDB();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
