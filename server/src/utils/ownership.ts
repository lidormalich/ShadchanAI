// ═══════════════════════════════════════════════════════════
// ShadchanAI — Ownership scope helper (Phase 3).
//
// Tri-state filter used on list endpoints:
//   - mine:  only rows where ownerField == current user
//   - team:  today behaves like "all" — there is no team/org
//            model yet. Kept as a distinct value so callers and
//            UI can evolve later without another API break.
//   - all:   no owner filter (default)
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { z } from 'zod';

export const OwnershipScope = {
  MINE: 'mine',
  TEAM: 'team',
  ALL: 'all',
} as const;
export type OwnershipScope = (typeof OwnershipScope)[keyof typeof OwnershipScope];

export const OwnershipScopeSchema = z.enum(['mine', 'team', 'all']).optional();

export function applyOwnershipFilter(
  filter: Record<string, unknown>,
  ownershipField: string,
  scope: OwnershipScope | undefined,
  currentUserId: string | undefined,
): void {
  if (!scope || scope === 'all') return;
  if (scope === 'team') {
    // TODO (Phase 3.x): once an org/team model exists, translate
    // into `ownerField ∈ teamMemberIds`. For now team == all.
    return;
  }
  if (scope === 'mine' && currentUserId) {
    filter[ownershipField] = new Types.ObjectId(currentUserId);
  }
}
