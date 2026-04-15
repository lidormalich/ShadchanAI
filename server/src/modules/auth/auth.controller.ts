import type { Request, Response, NextFunction } from 'express';
import * as svc from './auth.service.js';
import { ok, created } from '../../utils/response.js';
import { ensureUser, ensureRole } from '../../middleware/permissions.js';
import type { LoginInput, RegisterInput } from './auth.validator.js';
import { env } from '../../config/env.js';

export async function loginHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await svc.login(req.body as LoginInput, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    ok(res, result);
  } catch (e) { next(e); }
}

export async function meHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    ok(res, await svc.getUserById(user.id));
  } catch (e) { next(e); }
}

export async function registerHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const caller = ensureUser(req.user);
    ensureRole(caller, 'admin');
    const u = await svc.registerUser(req.body as RegisterInput, caller.id);
    created(res, { id: String(u._id), email: u.email, name: u.name, roles: u.roles });
  } catch (e) { next(e); }
}

export async function bootstrapHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Only available in non-production, and only when there are zero users.
  try {
    if (env.NODE_ENV === 'production') {
      res.status(404).json({ success: false, error: { code: 'not_found', message: 'Route not found' } });
      return;
    }
    const result = await svc.bootstrapAdminIfNeeded(req.body as RegisterInput);
    if (!result.bootstrapped) {
      res.status(409).json({
        success: false,
        error: { code: 'conflict', message: 'Users already exist — bootstrap not available' },
      });
      return;
    }
    created(res, {
      bootstrapped: true,
      user: { id: String(result.user!._id), email: result.user!.email, roles: result.user!.roles },
    });
  } catch (e) { next(e); }
}

export async function changePasswordHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = ensureUser(req.user);
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    await svc.changePassword(user.id, currentPassword, newPassword);
    res.status(204).end();
  } catch (e) { next(e); }
}
