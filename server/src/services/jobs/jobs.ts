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
import { downloadInboundMedia } from '../whatsapp/media.service.js';
import { refreshStaleInsights } from '../ai/candidate-learning.service.js';
import { runPhotoStorageMaintenance } from '../storage/photo-maintenance.service.js';
import { getSettingCached } from '../../modules/settings/settings.service.js';
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

// ── Candidate learning refresh ───────────────────────────
// Rebuilds the learned per-candidate insight (CandidateInsight) for
// internal candidates whose suggestion journal gained new entries
// (status changes + operator reasons) since the last build. Cheap
// no-op when nothing changed; capped per run to bound AI spend.
registerJob({
  name: 'candidate-learning-refresh',
  intervalMs: 60 * 60 * 1000, // hourly
  async run() {
    if (env.AI_DISABLED) return;
    const enabled = await getSettingCached('learning.refresh_enabled').catch(() => true);
    if (!enabled) return;
    const limit = await getSettingCached('learning.refresh_limit').catch(() => 15);
    const r = await refreshStaleInsights(Number(limit) || 15);
    if (r.rebuilt > 0) {
      log.info({ job: 'candidate-learning-refresh', ...r }, 'insights rebuilt');
    }
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
      // A caption-only image card is extractable (orchestrator falls back
      // to mediaCaption) — the old body-only filter left such messages
      // stuck in `pending` forever if the process died mid-extraction.
      // An IMAGE-ONLY card (no body, no caption) is ALSO extractable — the
      // orchestrator runs vision on it — so include contentType=image too,
      // otherwise a vision failure (e.g. rate-limit) orphans it in pending
      // with no path back into the pipeline.
      $and: [
        {
          $or: [
            { body: { $exists: true, $ne: '' } },
            { mediaCaption: { $exists: true, $ne: '' } },
            { contentType: 'image' },
          ],
        },
      ],
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

// ── Media-download reconciler ────────────────────────────
// Retries image downloads that failed at ingest (transient network /
// socket teardown). Only young messages are retried — WhatsApp media
// keys expire, so after 24h a retry cannot succeed anyway.
registerJob({
  name: 'media-download-reconciler',
  intervalMs: 10 * 60 * 1000, // every 10 minutes
  async run() {
    const youngCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const missing = await Message.find({
      direction: MessageDirection.INBOUND,
      contentType: 'image',
      mediaUrl: { $exists: false },
      createdAt: { $gt: youngCutoff },
      // Give up after 3 failed attempts — an expired media key ("bad
      // decrypt") will fail identically forever. $not/$gte also matches
      // docs with no attempts field yet.
      mediaDownloadAttempts: { $not: { $gte: 3 } },
    })
      .select('_id')
      .limit(20)
      .lean()
      .exec();
    if (missing.length === 0) return;
    let ok = 0;
    for (const doc of missing) {
      const r = await downloadInboundMedia(String(doc._id));
      if (r.ok) ok++;
    }
    if (ok > 0) log.info({ job: 'media-download-reconciler', downloaded: ok, attempted: missing.length }, 'media backfilled');
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
if (env.WA_ENABLED && env.WA_WATCHDOG_ENABLED) {
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

// ── Candidate photo storage maintenance ──────────────────
// Backfills external photos to R2, relocates objects whose candidate
// changed lifecycle folder, and deletes junk/ photos past retention.
// No-op when R2 is unconfigured (env.r2Enabled === false).
registerJob({
  name: 'photo-storage-maintenance',
  intervalMs: 30 * 60 * 1000, // every 30 minutes
  async run() {
    const r = await runPhotoStorageMaintenance();
    if (r && (r.backfilled > 0 || r.reconciled > 0 || r.junkDeleted > 0)) {
      log.info({ job: 'photo-storage-maintenance', ...r }, 'photo maintenance complete');
    }
  },
});

// ── Task reminder sweep (placeholder) ────────────────────
// Future: scan overdue tasks and write a per-owner digest.
registerJob({
  name: 'task-reminder-sweep',
  intervalMs: 30 * 60 * 1000, // every 30 minutes
  async run() {
    // Future: emit notifications / write a digest task record
  },
});
