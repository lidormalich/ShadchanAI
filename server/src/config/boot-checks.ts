// ═══════════════════════════════════════════════════════════
// Boot-time sanity checks (Phase 7 hardening).
//
// Runs early in server.ts main() to fail loudly when a critical
// runtime assumption is unmet. Distinguishes between FATAL
// conditions (exit with non-zero) and WARNINGS (log + continue).
//
// Production-fatal conditions include:
//   - WA_SESSIONS_DIR missing or not writable  (Baileys creds live here)
//   - No AI provider configured and AI not explicitly disabled
//     (already validated at Zod stage, but re-checked here to
//     catch AI_DISABLED drift between env parse and boot)
//
// Non-fatal warnings (dev + prod):
//   - AUTH_DEV_HEADER_ALLOWED=true outside production
//   - WA_AUTO_START_SESSIONS=true — reminder that multi-instance
//     deploys must set this to false
// ═══════════════════════════════════════════════════════════

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { env } from './env.js';

type CheckLevel = 'fatal' | 'warn';
interface CheckResult {
  level: CheckLevel;
  name: string;
  message: string;
}

export async function runBootChecks(): Promise<void> {
  const results: CheckResult[] = [];

  // ── WhatsApp session directory ────────────────────────
  const waDir = env.WA_SESSIONS_DIR;
  try {
    await fs.mkdir(waDir, { recursive: true });
    // Touch a probe file to confirm write permission. We delete
    // immediately; any failure bubbles to the catch.
    const probe = path.join(waDir, `.writable-probe-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
  } catch (e) {
    results.push({
      level: env.NODE_ENV === 'production' ? 'fatal' : 'warn',
      name: 'wa_sessions_dir',
      message:
        `WA_SESSIONS_DIR "${waDir}" is missing or not writable (${(e as Error).message}). ` +
        'Baileys credentials are stored here — if this is a container deployment, ' +
        'ensure a persistent volume is mounted.',
    });
  }

  // ── AI provider availability (prod only re-check) ─────
  if (env.NODE_ENV === 'production' && !env.AI_DISABLED) {
    if (!env.GROQ_API_KEY && !env.FALLBACK_API_KEY) {
      results.push({
        level: 'fatal',
        name: 'ai_provider',
        message:
          'No AI provider configured (GROQ_API_KEY and FALLBACK_API_KEY both empty). ' +
          'Extraction fallback and advisory services will fail. Set AI_DISABLED=true to continue without AI.',
      });
    }
  }

  // ── AUTH_DEV_HEADER_ALLOWED ───────────────────────────
  // Already fatal in prod at Zod; warn loudly in dev so it's visible.
  if (env.NODE_ENV !== 'production' && env.AUTH_DEV_HEADER_ALLOWED) {
    results.push({
      level: 'warn',
      name: 'auth_dev_header',
      message:
        'AUTH_DEV_HEADER_ALLOWED=true — dev-only header auth is enabled. ' +
        'Never deploy this configuration to production.',
    });
  }

  // ── Multi-instance auto-start reminder ────────────────
  if (env.WA_AUTO_START_SESSIONS) {
    results.push({
      level: 'warn',
      name: 'wa_auto_start',
      message:
        'WA_AUTO_START_SESSIONS=true — this process will boot every active ' +
        'Baileys session. Single-instance only; for multi-instance deployments ' +
        'set to false and start sessions from a dedicated worker.',
    });
  }

  // ── Report ─────────────────────────────────────────────
  const fatal = results.filter((r) => r.level === 'fatal');
  const warns = results.filter((r) => r.level === 'warn');

  for (const w of warns) {
    console.warn(`[boot] ⚠  ${w.name}: ${w.message}`);
  }
  for (const f of fatal) {
    console.error(`[boot] ✖  ${f.name}: ${f.message}`);
  }
  if (fatal.length > 0) {
    console.error(`[boot] ${fatal.length} fatal check(s) failed — refusing to start.`);
    process.exit(1);
  }

  console.log(`[boot] checks passed (${warns.length} warning(s))`);
}
