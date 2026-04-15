// ═══════════════════════════════════════════════════════════
// ShadchanAI — In-Process Extraction Queue
//
// MVP: a single-process async queue with bounded concurrency. Each
// entry = one messageId to process. The reconciler job also enqueues
// here. When we outgrow this (multi-instance deploys, heavy traffic)
// replace with BullMQ — the `enqueue()` signature stays the same.
//
// Why no external queue yet:
//   - Baileys is already single-process (socket pinned to a Node
//     instance). Until we shard WhatsApp across instances, extraction
//     is naturally pinned alongside it.
//   - Kept dead simple: if the process dies mid-extraction, the
//     reconciler job picks up stuck `extraction.status=pending`.
// ═══════════════════════════════════════════════════════════

import { MessageExtractionStatus, ExtractionMethod } from '@shadchanai/shared';
import { Message } from '../../models/index.js';
import { processMessageExtraction } from './orchestrator.js';

const MAX_CONCURRENCY = 3;

const queue: string[] = [];
const inFlight = new Set<string>();
let running = 0;

/**
 * Enqueue a message for extraction. Returns immediately; processing
 * happens on the next microtask. Idempotent: adding the same messageId
 * while it's already queued or in flight is a no-op.
 *
 * Also writes extraction.status=pending so the reconciler can find
 * stragglers if the process dies.
 */
export async function enqueueExtraction(messageId: string): Promise<void> {
  if (!messageId) return;
  if (queue.includes(messageId) || inFlight.has(messageId)) return;

  // Mark pending in DB so reconciler can see stalled items.
  try {
    await Message.updateOne(
      { _id: messageId },
      {
        $set: {
          'extraction.status': MessageExtractionStatus.PENDING,
          'extraction.method': ExtractionMethod.REGEX,
          'extraction.attemptedAt': new Date(),
        },
      },
    ).exec();
  } catch {
    // Non-fatal — processor will still pick it up, just without a pending marker.
  }

  queue.push(messageId);
  drain();
}

function drain(): void {
  while (running < MAX_CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!;
    if (inFlight.has(id)) continue;
    inFlight.add(id);
    running += 1;
    void runOne(id);
  }
}

async function runOne(id: string): Promise<void> {
  try {
    await processMessageExtraction(id);
  } catch (err) {
    // Final safety net — orchestrator is already swallowing + persisting
    // most failures, but catch anything that escapes so the queue stays alive.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      event: 'extraction_queue_error',
      messageId: id,
      error: (err as Error).message,
    }));
  } finally {
    inFlight.delete(id);
    running -= 1;
    drain();
  }
}

export function queueStats(): { queued: number; inFlight: number; running: number } {
  return { queued: queue.length, inFlight: inFlight.size, running };
}
