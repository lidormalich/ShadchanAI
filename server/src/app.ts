// ═══════════════════════════════════════════════════════════
// ShadchanAI — Express App
//
// Middleware order:
//   1. requestId      — attach correlation id first
//   2. helmet         — safe headers on every response
//   3. cors           — allow only configured origins
//   4. WhatsApp webhook (raw-body capture) — BEFORE the global body parser
//   5. express.json() — global body parser
//   6. optionalAuth   — attach req.user if JWT present
//   7. requestLogger  — per-request log line
//   8. rate limiter   — default cap
//   9. routers        — health → auth → domain modules
//  10. 404 + error handler
// ═══════════════════════════════════════════════════════════

import express, { type Express } from 'express';

import { errorMiddleware } from './middleware/error.middleware.js';
import { optionalAuth } from './middleware/auth.middleware.js';
import {
  corsMiddleware,
  helmetMiddleware,
  requestIdMiddleware,
} from './middleware/security.middleware.js';
import { requestLogger } from './middleware/requestLogger.middleware.js';
import { aiRateLimiter, defaultRateLimiter } from './middleware/rateLimiter.middleware.js';

import { env } from './config/env.js';

import { healthRouter } from './modules/health/health.router.js';
import { authRouter } from './modules/auth/auth.router.js';
import { internalCandidateRouter } from './modules/candidates/internal-candidate.router.js';
import { externalCandidateRouter } from './modules/candidates/external-candidate.router.js';
import { matchRouter } from './modules/matches/match.router.js';
import { conversationRouter } from './modules/conversations/conversation.router.js';
import { channelRouter } from './modules/channels/channel.router.js';
import { taskRouter } from './modules/tasks/task.router.js';
import { noteRouter } from './modules/notes/note.router.js';
import { aiRouter } from './services/ai/ai.router.js';
import { extractionRouter } from './modules/extraction/extraction.router.js';
import { auditRouter } from './modules/audit/audit.router.js';
import { userRouter } from './modules/users/user.router.js';
import { realtimeRouter } from './modules/realtime/realtime.router.js';
import { dashboardRouter } from './modules/dashboard/dashboard.router.js';
import { searchRouter } from './modules/search/search.router.js';
import { notificationsRouter } from './modules/notifications/notifications.router.js';
import { insightsRouter } from './modules/insights/insights.router.js';
import { settingsRouter } from './modules/settings/settings.router.js';
import { monitoringRouter } from './modules/monitoring/monitoring.router.js';
import { safeModeRouter } from './modules/safe-mode/safe-mode.router.js';
import { ensureNotificationsStarted } from './services/notifications/notifications.service.js';

export function buildApp(): Express {
  const app = express();

  // Trust first proxy hop for correct req.ip behind a load balancer
  app.set('trust proxy', 1);

  // ── 1. Request ID (every response includes X-Request-Id) ─
  app.use(requestIdMiddleware);

  // ── 2. Security headers ───────────────────────────────
  app.use(helmetMiddleware);

  // ── 3. CORS (explicit allow-list) ─────────────────────
  app.use(corsMiddleware);

  // ── 4. Global body parser ─────────────────────────────
  // NOTE: We moved off Meta webhooks → Baileys (socket-based).
  // No raw-body preservation needed. No inbound HTTP for WhatsApp.
  app.use(express.json({ limit: env.BODY_LIMIT }));

  // ── 6. Optional auth (attaches req.user when a JWT is valid) ──
  app.use(optionalAuth);

  // ── 7. Request logger ─────────────────────────────────
  app.use(requestLogger);

  // ── 8. Default rate limiter for all /api routes (exceptions
  //       below override with stricter limits) ─────────────
  app.use('/api', defaultRateLimiter);

  // ── 9. Routers ────────────────────────────────────────
  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/ai', aiRateLimiter, aiRouter);
  app.use('/api/candidates/internal', internalCandidateRouter);
  app.use('/api/candidates/external', externalCandidateRouter);
  app.use('/api/matches', matchRouter);
  app.use('/api/conversations', conversationRouter);
  app.use('/api/channels', channelRouter);
  app.use('/api/tasks', taskRouter);
  app.use('/api/notes', noteRouter);
  app.use('/api/extraction', extractionRouter);
  app.use('/api/audit-logs', auditRouter);
  app.use('/api/users', userRouter);
  app.use('/api/realtime', realtimeRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/insights', insightsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/monitoring', monitoringRouter);
  app.use('/api/safe-mode', safeModeRouter);

  // Start the notifications feed subscription as part of app bootstrap
  // so events are captured even before the first /api/notifications GET.
  ensureNotificationsStarted();

  // ── 10. 404 ────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ success: false, error: { code: 'not_found', message: 'Route not found' } });
  });

  // ── 11. Error handler ──────────────────────────────────
  app.use(errorMiddleware);

  return app;
}
