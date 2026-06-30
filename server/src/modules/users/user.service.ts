// ═══════════════════════════════════════════════════════════
// Users directory service — Phase 3.
// Holds the Mongoose access for the minimal active-users listing
// used by owner display and task assignment.
// ═══════════════════════════════════════════════════════════

import { User } from '../../models/index.js';

export interface UserDirectoryEntry {
  id: string;
  name: string;
  email: string;
  roles: string[];
  isActive: boolean;
}

export async function listActiveUsers(): Promise<UserDirectoryEntry[]> {
  const users = await User.find({ isActive: true })
    .select('_id name email roles isActive')
    .sort({ name: 1 })
    .lean()
    .exec();

  return users.map((u) => ({
    id: String(u._id),
    name: u.name,
    email: u.email,
    roles: u.roles,
    isActive: u.isActive,
  }));
}
