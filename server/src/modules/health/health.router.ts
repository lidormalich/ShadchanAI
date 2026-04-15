// ═══════════════════════════════════════════════════════════
// ShadchanAI — Health + Readiness
//
//   /api/health    — basic liveness (server responding)
//   /api/readiness — DB reachable + env minimally valid
//
// Never performs expensive provider calls (no Groq/OpenAI pings).
// Safe to hit from load balancers / k8s probes.
// ═══════════════════════════════════════════════════════════

import { Router } from 'express';
import mongoose from 'mongoose';
import { env } from '../../config/env.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    data: {
      ok: true,
      ts: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      nodeEnv: env.NODE_ENV,
    },
  });
});

healthRouter.get('/readiness', async (_req, res) => {
  const checks = {
    server: true,
    env: Boolean(env.MONGODB_URI && env.JWT_SECRET),
    db: mongoose.connection.readyState === 1,
  };
  const allOk = Object.values(checks).every(Boolean);
  res.status(allOk ? 200 : 503).json({
    success: allOk,
    data: {
      ok: allOk,
      checks,
      ts: new Date().toISOString(),
    },
  });
});
