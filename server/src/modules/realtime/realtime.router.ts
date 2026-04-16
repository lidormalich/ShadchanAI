// ═══════════════════════════════════════════════════════════
// SSE endpoint for operational awareness events.
// GET /api/realtime/events  — text/event-stream.
// The client (useRealtimeEvents hook) consumes this and turns
// events into targeted React Query cache invalidations.
// ═══════════════════════════════════════════════════════════

import { Router, type Request, type Response, type NextFunction } from 'express';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { verifyToken } from '../auth/auth.service.js';
import { UnauthorizedError } from '../../utils/errors.js';
import { subscribeRealtime } from '../../services/realtime/realtime.service.js';

export const realtimeRouter = Router();

// Browsers cannot send custom headers on EventSource, so for the
// SSE endpoint we ALSO accept auth as a query string parameter
// (?token=... or ?dev_user=...). The header path continues to
// work unchanged for non-browser clients.
function sseAuth(req: Request, _res: Response, next: NextFunction): void {
  const headerAuth = req.header('authorization');
  const queryToken = typeof req.query['token'] === 'string' ? (req.query['token'] as string) : undefined;
  const token = headerAuth?.startsWith('Bearer ')
    ? headerAuth.slice('Bearer '.length)
    : queryToken;
  if (token) {
    const payload = verifyToken(token);
    if (payload && Types.ObjectId.isValid(payload.sub)) {
      req.user = { id: payload.sub, roles: payload.roles ?? ['shadchan'], email: payload.email };
      next();
      return;
    }
  }
  if (env.AUTH_DEV_HEADER_ALLOWED) {
    const devUser = (req.header('x-dev-user') ?? (req.query['dev_user'] as string | undefined));
    if (devUser && Types.ObjectId.isValid(devUser)) {
      req.user = { id: devUser, roles: ['admin', 'shadchan'] };
      next();
      return;
    }
  }
  next(new UnauthorizedError('Authentication required'));
}

realtimeRouter.get('/events', sseAuth, (req: Request, res: Response) => {
  // SSE headers. We intentionally avoid compression here — Express
  // compression middleware can buffer chunks and break SSE delivery.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders?.();

  // Initial comment so proxies see traffic immediately.
  res.write(': connected\n\n');

  const unsubscribe = subscribeRealtime((event) => {
    // Standard SSE frame. `event:` helps clients dispatch by type.
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Keep-alive ping every 25s to survive idle-connection killers.
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  });
});
