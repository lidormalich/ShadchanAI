// ═══════════════════════════════════════════════════════════
// ShadchanAI — Server Entry Point
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import { buildApp } from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { env } from './config/env.js';
import { runBootChecks } from './config/boot-checks.js';
import { startJobScheduler, stopJobScheduler } from './services/jobs/job.scheduler.js';
import { startAllChannels, stopAllChannels } from './services/whatsapp/providers/baileys/baileys.client.js';
// Importing jobs.ts registers all jobs as a side-effect:
import './services/jobs/jobs.js';

async function main(): Promise<void> {
  // Boot-time guards — bail before opening DB / Baileys if the
  // environment would obviously cause silent failures.
  await runBootChecks();

  await connectDB();
  const app = buildApp();

  startJobScheduler();

  // Boot Baileys sessions for every active channel.
  // Must be single-instance; see deployment notes on scale-out.
  if (env.WA_AUTO_START_SESSIONS) {
    void startAllChannels().catch((err) =>
      console.error('[server] startAllChannels failed:', err),
    );
  }

  const server = app.listen(env.PORT, () => {
    console.log(`[server] listening on :${env.PORT} (${env.NODE_ENV})`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[server] received ${signal}, shutting down`);
    stopJobScheduler();
    await stopAllChannels().catch(() => { /* best-effort */ });
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    // Force-exit after 10s
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((err) => {
  console.error('[server] startup failed:', err);
  process.exit(1);
});
