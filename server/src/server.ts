// ═══════════════════════════════════════════════════════════
// ShadchanAI — Server Entry Point
//
// Boot order (multi-session safe):
//   1. boot-checks (env validation, etc.)
//   2. DB connect
//   3. Build app
//   4. Job scheduler
//   5. (optional) recover stale Baileys locks from prior runs
//   6. (optional) parallel auto-start of every active channel
//   7. HTTP listen
//   8. Install SIGINT/SIGTERM handlers (idempotent)
//
// Shutdown order:
//   1. Stop accepting NEW HTTP traffic (server.close())
//   2. Stop the job scheduler
//   3. Stop every Baileys client (Promise.allSettled, with timeout)
//   4. Explicit releaseAllChannelLocks('shutdown') — even if step 3
//      partially failed, the persisted lock state ends up clean
//   5. Disconnect the DB and exit
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import { buildApp } from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { reconcileIndexes } from './config/index-migrations.js';
import { env } from './config/env.js';
import { runBootChecks } from './config/boot-checks.js';
import { startJobScheduler, stopJobScheduler } from './services/jobs/job.scheduler.js';
import { refreshParserLabels } from './modules/extraction/card-label.service.js';
import {
  startAllChannels,
  stopAllChannels,
} from './services/whatsapp/providers/baileys/baileys.client.js';
import {
  INSTANCE_ID,
  recoverStaleChannelLocks,
  releaseAllChannelLocks,
} from './services/whatsapp/instance.lock.js';
// Importing jobs.ts registers all jobs as a side-effect:
import './services/jobs/jobs.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('server');

const SHUTDOWN_HARD_DEADLINE_MS = 15_000;
const STOP_ALL_CHANNELS_TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | { timedOut: true; label: string }> {
  return Promise.race([
    p,
    new Promise<{ timedOut: true; label: string }>((resolve) =>
      setTimeout(() => resolve({ timedOut: true, label }), ms),
    ),
  ]);
}

async function main(): Promise<void> {
  await runBootChecks();
  await connectDB();
  await reconcileIndexes();
  // Load operator-taught card-label mappings into the parser (Feature C).
  // Best-effort — a failure here must not block boot; the parser still has
  // its built-in synonyms.
  try {
    await refreshParserLabels();
  } catch (err) {
    log.error({ error: (err as Error).message }, 'card_labels_boot_load_failed');
  }
  const app = buildApp();
  startJobScheduler();

  log.info({
    instanceId: INSTANCE_ID,
    autoStart: env.WA_AUTO_START_SESSIONS,
    nodeEnv: env.NODE_ENV,
  }, 'server_boot');

  if (!env.WA_ENABLED) {
    log.info({ note: 'WA_ENABLED=false; WhatsApp engine off on this instance (no sockets, no auto-start, no watchdog)' }, 'whatsapp_engine_disabled');
  } else if (env.WA_AUTO_START_SESSIONS) {
    // Recover anything left over from a crashed previous run BEFORE
    // the auto-start loop, so its outcome reports describe real
    // conflicts (another live process) and not dead lock leftovers.
    try {
      const recovered = await recoverStaleChannelLocks();
      if (recovered.recovered > 0) {
        log.warn({ count: recovered.recovered }, 'baileys_boot_stale_locks_recovered');
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'stale-lock recovery failed');
    }
    // Fire-and-forget: each channel attempt is independent, so we
    // don't block the HTTP listen on a slow Baileys handshake. The
    // structured BootStartupReport is logged from inside startAllChannels.
    void startAllChannels().catch((err) =>
      log.error({ err }, 'startAllChannels failed'),
    );
  } else {
    log.info({ note: 'WA_AUTO_START_SESSIONS=false; channels must be started via API' }, 'baileys_auto_start_disabled');
  }

  const server = app.listen(env.PORT, () => {
    log.info({ port: env.PORT, nodeEnv: env.NODE_ENV, instanceId: INSTANCE_ID }, 'listening');
  });

  // ── Graceful shutdown ──────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      log.info({ signal }, 'received signal during shutdown; ignoring');
      return;
    }
    shuttingDown = true;
    const startedAt = Date.now();
    log.info({ signal, instanceId: INSTANCE_ID }, 'server_shutdown_begin');

    // 1. Stop accepting NEW connections immediately.
    server.close((err) => {
      if (err) log.error({ error: err.message }, 'http close error');
    });

    // 2. Stop scheduler (synchronous, fast).
    try { stopJobScheduler(); } catch (e) { log.error({ error: (e as Error).message }, 'stopJobScheduler'); }

    // 3. Stop every Baileys client. Bounded by a timeout so a
    //    hung socket can't keep the process alive past the
    //    hard shutdown deadline.
    const stopRes = await withTimeout(
      stopAllChannels().catch((e) => {
        log.error({ error: (e as Error).message }, 'stopAllChannels error');
        return { instanceId: INSTANCE_ID, total: 0, stopped: 0, failed: 0, durationMs: 0, failures: [] };
      }),
      STOP_ALL_CHANNELS_TIMEOUT_MS,
      'stopAllChannels',
    );
    if ('timedOut' in stopRes) {
      log.warn({ timeoutMs: STOP_ALL_CHANNELS_TIMEOUT_MS }, 'baileys_shutdown_stop_timeout');
    }

    // 4. Always release ALL locks owned by this process — even if
    //    step 3 partially failed. This is the critical fix for the
    //    "next boot sees channel_skipped_lock_held" pattern.
    try {
      const released = await releaseAllChannelLocks('shutdown');
      log.info({ count: released.released }, 'baileys_shutdown_locks_released');
    } catch (e) {
      log.error({ error: (e as Error).message }, 'releaseAllChannelLocks');
    }

    // 5. Disconnect DB and exit cleanly.
    try { await disconnectDB(); } catch (e) { log.error({ error: (e as Error).message }, 'disconnectDB'); }

    log.info({
      signal,
      instanceId: INSTANCE_ID,
      durationMs: Date.now() - startedAt,
    }, 'server_shutdown_complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Hard deadline: if shutdown stalls past this, force-exit so the
  // process supervisor can restart us cleanly. Shorter than the K8s
  // / docker default (30s) on purpose.
  const installHardDeadline = (signal: string) => {
    setTimeout(() => {
      log.error({ signal }, 'shutdown deadline exceeded, forcing exit');
      process.exit(1);
    }, SHUTDOWN_HARD_DEADLINE_MS).unref();
  };
  process.on('SIGTERM', () => installHardDeadline('SIGTERM'));
  process.on('SIGINT', () => installHardDeadline('SIGINT'));

  // ── Last-resort process guards (single-instance survival) ──
  // This process runs many fire-and-forget async paths (Baileys socket
  // events, saveCreds, background jobs). Without these handlers a single
  // stray rejection/throw on Node 22 would terminate the ONLY instance,
  // taking the API + SPA down for every operator.
  //
  //   unhandledRejection → log and KEEP SERVING. A rejected background
  //     promise (e.g. a failed creds save) must not kill the pilot.
  //   uncaughtException → state may be corrupt; log, then run the same
  //     bounded graceful shutdown so the supervisor restarts us cleanly.
  process.on('unhandledRejection', (reason) => {
    log.error({
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    }, 'unhandled_rejection');
  });
  process.on('uncaughtException', (err) => {
    log.error({ message: err.message, stack: err.stack }, 'uncaught_exception');
    installHardDeadline('uncaughtException');
    void shutdown('uncaughtException');
  });
}

void main().catch((err) => {
  log.error({ err }, 'startup failed');
  process.exit(1);
});
