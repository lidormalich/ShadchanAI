// ═══════════════════════════════════════════════════════════
// ShadchanAI — Registered Background Jobs
//
// Each job here is intentionally small and observable. When any
// job becomes heavy, migrate it to a queued worker — the shape
// of each job.run() function won't need to change.
// ═══════════════════════════════════════════════════════════

import { ChannelRole, MessageDirection, MessageExtractionStatus, MessageIngestionDecision } from '@shadchanai/shared';
import { ExternalCandidate, Message } from '../../models/index.js';
import { registerJob } from './job.scheduler.js';
import { enqueueExtraction } from '../extraction/queue.js';
import { runScanNow } from '../matching/match-scan.service.js';
import { replayFailedInboundMessages } from '../whatsapp/message.handler.js';
import { runConnectionWatchdog } from '../whatsapp/connection.watchdog.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('job');

// ── Stale external detection ─────────────────────────────
// Marks external candidates whose lastSourceUpdateAt is more
// than 90 days old. Confidence scoring already deducts on
// stale flags; this job keeps the boolean up to date.
registerJob({
  name: 'mark-stale-externals',
  intervalMs: 6 * 60 * 60 * 1000, // every 6 hours
  async run() {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const res = await ExternalCandidate.updateMany(
      {
        status: 'active',
        staleAt: { $exists: false },
        $or: [
          { lastSourceUpdateAt: { $lt: cutoff } },
          { lastSourceUpdateAt: { $exists: false }, sourceImportedAt: { $lt: cutoff } },
        ],
      },
      { $set: { staleAt: new Date() } },
    ).exec();
    if (res.modifiedCount > 0) {
      log.info({ job: 'mark-stale-externals', flagged: res.modifiedCount }, 'flagged profiles');
    }
  },
});

// ── AI enrichment refresh (placeholder) ──────────────────
// Intentionally left as a shell: production will populate AI
// summaries on new candidates. Keeping the job boundary clear
// so the enrichment logic can land in one place without app wiring.
registerJob({
  name: 'ai-enrichment-refresh',
  intervalMs: 60 * 60 * 1000, // hourly
  async run() {
    // Future: enqueue summaries for candidates missing aiEnrichment
    // that passed a minimum profileCompletion threshold.
  },
});

// ── Extraction reconciler ────────────────────────────────
// Rescues inbound profile messages whose extraction got stuck:
//   - status=pending for >2 minutes (process crash mid-run)
//   - OR no extraction subdoc at all on a profiles_source inbound
//     message younger than 24h (hook miss during deploy / hotfix)
// Also re-enqueues status=failed messages once per hour, but only up to
// MAX_EXTRACTION_RETRIES attempts. Beyond the cap they stay failed for
// manual inspection (operators can still force a retry via POST /run),
// so a permanently-failing body can't loop on the AI provider forever.
const MAX_EXTRACTION_RETRIES = 3;

registerJob({
  name: 'extraction-reconciler',
  intervalMs: 5 * 60 * 1000, // every 5 minutes
  async run() {
    const now = Date.now();
    const stalePending = new Date(now - 2 * 60 * 1000);
    const failedRetryCutoff = new Date(now - 60 * 60 * 1000);
    const backfillCutoff = new Date(now - 24 * 60 * 60 * 1000);

    const candidates = await Message.find({
      channelRole: ChannelRole.PROFILES_SOURCE,
      direction: MessageDirection.INBOUND,
      body: { $exists: true, $ne: '' },
      $or: [
        { 'extraction.status': MessageExtractionStatus.PENDING, 'extraction.attemptedAt': { $lt: stalePending } },
        {
          'extraction.status': MessageExtractionStatus.FAILED,
          'extraction.attemptedAt': { $lt: failedRetryCutoff },
          // $not/$gte also matches legacy docs with no retryCount field.
          'extraction.retryCount': { $not: { $gte: MAX_EXTRACTION_RETRIES } },
        },
        {
          extraction: { $exists: false },
          createdAt: { $gt: backfillCutoff },
          // Exclude messages the ingestion gate deliberately held back
          // (chat unmapped / mapped to ignore / match_sending). Those
          // have no extraction subdoc on purpose; re-enqueuing them here
          // would bypass the chat-mapping gate and silently process
          // "pending" chats. They only enter extraction via an explicit
          // operator backfill (see channel.service.backfillChatExtraction).
          'ingestion.decision': {
            $nin: [
              MessageIngestionDecision.IGNORED_ASSIGNED_IGNORE,
              MessageIngestionDecision.IGNORED_MATCH_SENDING,
              MessageIngestionDecision.IGNORED_UNMAPPED,
            ],
          },
        },
      ],
    })
      .select('_id')
      .limit(50)
      .lean()
      .exec();

    if (candidates.length === 0) return;
    for (const doc of candidates) {
      await enqueueExtraction(String(doc._id));
    }
    log.info({ job: 'extraction-reconciler', reEnqueued: candidates.length }, 're-enqueued messages');
  },
});

// ── Incremental match scan ───────────────────────────────
// Re-scores only the candidates whose engine-relevant fields changed
// since the last run (or are new), caches the score per pair, and
// auto-creates draft suggestions for strong eligible pairs. When
// nothing changed the run does zero engine work. Operators can also
// trigger this on demand via POST /matches/scan.
registerJob({
  name: 'incremental-match-scan',
  intervalMs: 60 * 60 * 1000, // hourly
  async run() {
    const summary = await runScanNow({ trigger: 'job', mode: 'incremental' });
    if (summary && (summary.pairsScored > 0 || summary.draftsCreated > 0)) {
      log.info({
        job: 'incremental-match-scan',
        pairsScored: summary.pairsScored,
        pairsSkipped: summary.pairsSkipped,
        draftsCreated: summary.draftsCreated,
        durationMs: summary.durationMs,
      }, 'scan complete');
    }
  },
});

// ── Replay dead-lettered inbound WhatsApp messages ───────
// Inbound persistence that failed on a transient DB fault is recorded to
// the FailedInboundMessage dead-letter store. This job replays due rows so
// no inbound message is permanently lost to a momentary DB blip. Replays
// are idempotent (unique externalMessageId), so a re-run is always safe.
registerJob({
  name: 'replay-failed-inbound',
  intervalMs: 2 * 60 * 1000, // every 2 minutes
  async run() {
    const r = await replayFailedInboundMessages(50);
    if (r.resolved > 0 || r.parked > 0) {
      log.info({
        job: 'replay-failed-inbound',
        resolved: r.resolved,
        retrying: r.failed,
        parked: r.parked,
      }, 'replay complete');
    }
  },
});

// ── WhatsApp connection watchdog ─────────────────────────
// Self-heals sessions that dropped and stopped reconnecting on their own
// (circuit tripped open, or client missing after a restart). Keeps them
// ONLINE without cycling healthy connections. Gated + interval-tuned via
// env; single-instance only (same constraint as WA_AUTO_START_SESSIONS).
if (env.WA_WATCHDOG_ENABLED) {
  registerJob({
    name: 'wa-connection-watchdog',
    intervalMs: env.WA_WATCHDOG_INTERVAL_MS,
    async run() {
      const r = await runConnectionWatchdog();
      if (r.revived.length > 0) {
        log.info({ job: 'wa-connection-watchdog', ...r }, 'revived dropped sessions');
      }
    },
  });
}

// ── Task reminder sweep (placeholder) ────────────────────
// Future: scan overdue tasks and write a per-owner digest.
registerJob({
  name: 'task-reminder-sweep',
  intervalMs: 30 * 60 * 1000, // every 30 minutes
  async run() {
    // Future: emit notifications / write a digest task record
  },
});
