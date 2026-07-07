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
import { cooldownRemainingMs } from '../ai/ai-cooldown.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('extraction.queue');

const MAX_CONCURRENCY = 3;

// Minimum gap between STARTING two extractions. A backfill enqueues hundreds
// of messages at once; without spacing, MAX_CONCURRENCY of them fire back-to-
// back and, together with each one's classify+extract+embed calls, blow the
// per-minute AI token budget. Spacing turns that burst into a steady drip.
// Tunable via env for ops (e.g. raise it if the org's TPM tier is small).
const MIN_SPACING_MS = Number(process.env['EXTRACTION_MIN_SPACING_MS']) || 1200;

const queue: string[] = [];
const inFlight = new Set<string>();
let running = 0;
let lastStartedAt = 0;
let pumping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
  log.info({ messageId, queued: queue.length, inFlight: inFlight.size }, 'extraction_enqueued');
  schedulePump();
}

function schedulePump(): void {
  void pump();
}

// Single async loop that feeds work to the processor while honoring both the
// concurrency cap and two rate-limit guards: the global AI cooldown (a recent
// 429 pauses ALL new starts until the per-minute window rolls) and a minimum
// spacing between starts. Guarded by `pumping` so only one loop ever runs;
// runOne re-schedules it as slots free.
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length > 0 && running < MAX_CONCURRENCY) {
      // 1. Global AI cooldown — a 429 anywhere holds the whole pipeline here.
      //    Re-checked after sleeping because concurrent work may extend it.
      const cd = cooldownRemainingMs();
      if (cd > 0) {
        await sleep(cd);
        continue;
      }
      // 2. Min spacing — never start two extractions closer than MIN_SPACING_MS.
      const sinceLast = Date.now() - lastStartedAt;
      if (sinceLast < MIN_SPACING_MS) {
        await sleep(MIN_SPACING_MS - sinceLast);
        continue;
      }

      const id = queue.shift()!;
      if (inFlight.has(id)) continue;
      inFlight.add(id);
      running += 1;
      lastStartedAt = Date.now();
      void runOne(id);
    }
  } finally {
    pumping = false;
  }
}

async function runOne(id: string): Promise<void> {
  try {
    await processMessageExtraction(id);
  } catch (err) {
    // Final safety net — orchestrator is already swallowing + persisting
    // most failures, but catch anything that escapes so the queue stays alive.
    log.error({ messageId: id, error: (err as Error).message }, 'extraction_queue_error');
  } finally {
    inFlight.delete(id);
    running -= 1;
    schedulePump();
  }
}

export function queueStats(): { queued: number; inFlight: number; running: number } {
  return { queued: queue.length, inFlight: inFlight.size, running };
}
