// ═══════════════════════════════════════════════════════════
// Minimal users directory — Phase 3.
// Returns active users for owner display and task assignment.
// Full team admin / user CRUD is intentionally out of scope.
// ═══════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import { User } from '../../models/index.js';
import { ensureUser } from '../../middleware/permissions.js';
import { ok } from '../../utils/response.js';

export async function listHandler(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    ensureUser(_req.user);
    const users = await User.find({ isActive: true })
      .select('_id name email roles isActive')
      .sort({ name: 1 })
      .lean()
      .exec();

    ok(res, users.map((u) => ({
      id: String(u._id),
      name: u.name,
      email: u.email,
      roles: u.roles,
      isActive: u.isActive,
    })));
  } catch (e) { next(e); }
}
