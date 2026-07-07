// Extraction recovery + diagnostic.
//
// Rate-limit bursts (org TPM exhausted by a group backfill) can leave inbound
// profile messages stuck: `extraction.status=failed` after the reconciler gave
// up (retryCount >= cap), or `pending` orphaned by a mid-run crash. Those are
// candidates that never made it in — "lost income".
//
// Read-only by default: prints a breakdown of recent PROFILES_SOURCE inbound
// messages by extraction status, with the failure reasons, so you can see the
// damage. With `--apply` it RESETS the recoverable ones (retryCount=0,
// status=pending) so the running server's extraction reconciler re-enqueues
// them — now smoothed by the new AI cooldown + queue spacing, so it won't
// re-blow the rate limit.
//
//   npm run extraction:recover              # diagnose last 3 days (read-only)
//   npm run extraction:recover -- --days 7  # widen the window
//   npm run extraction:recover -- --apply   # actually reset + let server reprocess
//
import dns from 'node:dns';
import { ChannelRole, MessageDirection, MessageExtractionStatus } from '@shadchanai/shared';
import { connectDB, disconnectDB } from '../config/db.js';
import { Message } from '../models/index.js';

// Same DNS pin as wa-diagnose — mongodb+srv:// SRV lookups fail on some
// Windows/Git-Bash setups with the default resolver.
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch { /* best-effort */ }

// Mirror the reconciler's cap so "given up" is computed the same way.
const MAX_EXTRACTION_RETRIES = 3;

function parseArgs(argv: string[]): { days: number; apply: boolean } {
  const apply = argv.includes('--apply');
  const daysIdx = argv.indexOf('--days');
  const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) || 3 : 3;
  return { days, apply };
}

async function main(): Promise<void> {
  const { days, apply } = parseArgs(process.argv.slice(2));
  await connectDB();

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const scope = {
    channelRole: ChannelRole.PROFILES_SOURCE,
    direction: MessageDirection.INBOUND,
    createdAt: { $gt: cutoff },
  };

  const total = await Message.countDocuments(scope);
  console.log(`\n══════ EXTRACTION HEALTH — last ${days}d ══════`);
  console.log(`profiles_source inbound messages: ${total}`);

  // Breakdown by extraction status (missing subdoc → 'none').
  const byStatus = await Message.aggregate([
    { $match: scope },
    { $group: { _id: { $ifNull: ['$extraction.status', 'none'] }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log('\nby extraction.status:');
  for (const r of byStatus) console.log(`  ${String(r._id).padEnd(22)} ${r.n}`);

  // The recoverable set: failed (any retryCount) + stuck pending.
  const failedFilter = { ...scope, 'extraction.status': MessageExtractionStatus.FAILED };
  const stuckPendingFilter = {
    ...scope,
    'extraction.status': MessageExtractionStatus.PENDING,
    'extraction.attemptedAt': { $lt: new Date(Date.now() - 2 * 60 * 1000) },
  };

  const failedTotal = await Message.countDocuments(failedFilter);
  const failedGaveUp = await Message.countDocuments({
    ...failedFilter,
    'extraction.retryCount': { $gte: MAX_EXTRACTION_RETRIES },
  });
  const stuckPending = await Message.countDocuments(stuckPendingFilter);

  // Why did the failed ones fail? Confirms rate-limit casualties vs real junk.
  const reasons = await Message.aggregate([
    { $match: failedFilter },
    { $group: { _id: { $ifNull: ['$extraction.failureReason', '(none)'] }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 12 },
  ]);

  console.log('\n── recoverable ──');
  console.log(`  failed (total):              ${failedTotal}`);
  console.log(`    ↳ of which gave up (retry≥${MAX_EXTRACTION_RETRIES}): ${failedGaveUp}`);
  console.log(`  stuck pending (>2m):         ${stuckPending}`);

  // Diagnose stuck-pending: image-only cards (no body/caption) are skipped by
  // the reconciler's text filter, so they orphan in pending. Surface that.
  if (stuckPending > 0) {
    const byType = await Message.aggregate([
      { $match: stuckPendingFilter },
      {
        $group: {
          _id: {
            contentType: '$contentType',
            hasText: {
              $or: [
                { $gt: [{ $strLenCP: { $ifNull: ['$body', ''] } }, 0] },
                { $gt: [{ $strLenCP: { $ifNull: ['$mediaCaption', ''] } }, 0] },
              ],
            },
          },
          n: { $sum: 1 },
        },
      },
    ]);
    console.log('    stuck-pending breakdown:');
    for (const r of byType) {
      console.log(`      contentType=${r._id.contentType ?? '?'} hasText=${r._id.hasText} → ${r.n}`);
    }
  }
  if (reasons.length) {
    console.log('\n  failed-reason breakdown:');
    for (const r of reasons) console.log(`    ${r.n.toString().padStart(4)}  ${String(r._id).slice(0, 90)}`);
  }

  const recoverable = failedTotal + stuckPending;
  if (!apply) {
    console.log(`\n${recoverable} message(s) are recoverable.`);
    console.log('Re-run with  --apply  to reset them; the running server will then reprocess');
    console.log('them gradually through the throttled queue (no rate-limit re-blow).');
    await disconnectDB();
    return;
  }

  if (recoverable === 0) {
    console.log('\nNothing to recover. ✅');
    await disconnectDB();
    return;
  }

  // Reset both buckets to PENDING with retryCount=0 and an old attemptedAt, so
  // the server's extraction-reconciler (runs every 5m, PENDING>2m branch) picks
  // them up and re-enqueues through the now-throttled, cooldown-aware queue.
  const reset = {
    $set: {
      'extraction.status': MessageExtractionStatus.PENDING,
      'extraction.retryCount': 0,
      'extraction.attemptedAt': new Date(0),
    },
    $unset: { 'extraction.failureReason': '' },
  };
  // Reset stuck-pending FIRST, then failed. If we did failed→pending first,
  // the stuck-pending pass would re-match those same rows (now pending with an
  // epoch attemptedAt) and double-count them via the schema's updatedAt bump.
  await Message.updateMany(stuckPendingFilter, reset).exec();
  await Message.updateMany(failedFilter, reset).exec();
  // Report the pre-counted distinct set rather than modifiedCount (which the
  // two passes can inflate).
  const resetCount = recoverable;

  console.log(`\n✅ Reset ${resetCount} message(s) to pending.`);
  console.log('The running server will reprocess them within ~5 minutes (50/run,');
  console.log('spaced to stay under the AI token-per-minute limit). Watch the logs for');
  console.log('`extraction-reconciler` re-enqueues and `flow_stop: created_new`.');

  await disconnectDB();
}

main().catch((err) => {
  console.error('extraction-recover failed:', err);
  process.exit(1);
});
