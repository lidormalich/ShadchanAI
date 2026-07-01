// ═══════════════════════════════════════════════════════════
// Boot-time index reconciliation.
//
// Mongoose creates indexes defined in a schema, but it NEVER drops or
// alters an index that already exists in the DB with different options.
// When we change an index definition we must drop the stale one so the
// new spec can be built. Each fix here is idempotent and guarded.
// ═══════════════════════════════════════════════════════════

import { ExternalCandidate } from '../models/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('db');

export async function reconcileIndexes(): Promise<void> {
  await fixExternalSourceIndex();
}

// The legacy { sourceType, sourceExternalId } unique+sparse index let only
// ONE manual/whatsapp external (no sourceExternalId → all collide on
// {sourceType, null}). It is now a PARTIAL unique index (enforced only when
// sourceExternalId exists). Drop the legacy form so the partial one builds.
async function fixExternalSourceIndex(): Promise<void> {
  try {
    const coll = ExternalCandidate.collection;
    const indexes = await coll.indexes();
    const legacy = indexes.find(
      (i) => i.name === 'sourceType_1_sourceExternalId_1' && !i.partialFilterExpression,
    );
    if (legacy) {
      await coll.dropIndex('sourceType_1_sourceExternalId_1');
      log.info('dropped legacy sourceType+sourceExternalId index — rebuilding as partial');
    }
    // (Re)build schema indexes, including the new partial unique one.
    await ExternalCandidate.createIndexes();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'external source index reconcile skipped');
  }
}
