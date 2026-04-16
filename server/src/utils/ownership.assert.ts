// ═══════════════════════════════════════════════════════════
// Ownership-assertion helper (Phase 7 hardening).
//
// Phase 3 introduced ownership READ filtering. This helper adds
// the missing WRITE-side check: any service mutation that
// touches an entity with an ownerUserId MUST pass it through
// assertOwnership(entityOwner, user) before persisting.
//
// Baseline rule:
//   - owner can mutate
//   - admin role can mutate anyone's entity
//   - otherwise ForbiddenError with a structured code so the UI
//     can surface a specific operator-friendly message
//
// Unowned legacy rows (ownerUserId missing) are treated as "team"
// and allow any authed shadchan to mutate — refusing those would
// brick data that predates ownership tracking.
// ═══════════════════════════════════════════════════════════

import type { Types } from 'mongoose';
import { ForbiddenError } from './errors.js';
import { hasRole, type AuthUser } from '../middleware/permissions.js';
import { recordNotOwnerAttempt } from '../services/monitoring/metrics.service.js';

export interface OwnershipAssertionOptions {
  /** Human-readable entity label used in the error message. */
  entity: string;
}

export function assertOwnership(
  entityOwner: Types.ObjectId | string | undefined | null,
  user: AuthUser,
  options: OwnershipAssertionOptions,
): void {
  // Legacy rows without ownership — permissive. Phase 3 documented
  // this; backfill is outside this phase's scope.
  if (!entityOwner) return;

  const ownerId = typeof entityOwner === 'string' ? entityOwner : String(entityOwner);
  if (ownerId === user.id) return;
  if (hasRole(user, 'admin')) return;

  recordNotOwnerAttempt({ entity: options.entity, ownerId, attemptedBy: user.id });
  throw new ForbiddenError(
    `This ${options.entity} is owned by another shadchan. Ask the owner to make the change or have an admin reassign it.`,
    'not_owner',
    { entity: options.entity, ownerId },
  );
}

/**
 * Variant that allows either owner OR assignee to mutate.
 * Used for tasks so a delegated shadchan can complete work.
 */
export function assertOwnershipOrAssignee(
  ownerId: Types.ObjectId | string | undefined | null,
  assigneeId: Types.ObjectId | string | undefined | null,
  user: AuthUser,
  options: OwnershipAssertionOptions,
): void {
  if (!ownerId && !assigneeId) return;
  const owner = ownerId ? (typeof ownerId === 'string' ? ownerId : String(ownerId)) : undefined;
  const assignee = assigneeId ? (typeof assigneeId === 'string' ? assigneeId : String(assigneeId)) : undefined;
  if (owner === user.id || assignee === user.id) return;
  if (hasRole(user, 'admin')) return;

  recordNotOwnerAttempt({ entity: options.entity, ownerId: owner, attemptedBy: user.id });
  throw new ForbiddenError(
    `This ${options.entity} belongs to another operator. Ask the owner/assignee or an admin.`,
    'not_owner',
    { entity: options.entity, ownerId: owner, assignedTo: assignee },
  );
}
