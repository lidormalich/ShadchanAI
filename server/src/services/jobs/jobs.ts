// ═══════════════════════════════════════════════════════════
// ShadchanAI — Registered Background Jobs
//
// Each job here is intentionally small and observable. When any
// job becomes heavy, migrate it to a queued worker — the shape
// of each job.run() function won't need to change.
// ═══════════════════════════════════════════════════════════

import { ChannelRole, MessageDirection, MessageExtractionStatus } from '@shadchanai/shared';
import { ExternalCandidate, Message } from '../../models/index.js';
import { registerJob } from './job.scheduler.js';
import { enqueueExtraction } from '../extraction/queue.js';

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
      console.log(`[job] mark-stale-externals: flagged ${res.modifiedCount} profiles`);
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
// Also re-enqueues status=failed messages once per hour for a single
// retry; failures beyond that stay for manual inspection.
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
        { 'extraction.status': MessageExtractionStatus.FAILED, 'extraction.attemptedAt': { $lt: failedRetryCutoff } },
        { extraction: { $exists: false }, createdAt: { $gt: backfillCutoff } },
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
    console.log(`[job] extraction-reconciler: re-enqueued ${candidates.length} messages`);
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
