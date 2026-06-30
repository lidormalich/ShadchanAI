// ═══════════════════════════════════════════════════════════
// ShadchanAI — Audit Service
//
// Centralized helper around the immutable AuditLog model.
// Services call this on every significant mutation.
//
// Never throws — failures are logged and swallowed so audit
// problems can't break user-visible operations.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import type { AuditActionType, AuditEntityType } from '@shadchanai/shared';
import { AuditLog } from '../models/index.js';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('audit');

let auditFailureCount = 0;
export function getAuditFailureCount(): number {
  return auditFailureCount;
}

export interface AuditInput {
  entityType: AuditEntityType;
  entityId: string;
  actionType: AuditActionType;
  performedBy: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    await AuditLog.create({
      entityType: input.entityType,
      entityId: toObjectId(input.entityId),
      actionType: input.actionType,
      performedBy: toObjectId(input.performedBy),
      before: redact(input.before),
      after: redact(input.after),
      metadata: input.metadata,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
  } catch (e) {
    auditFailureCount += 1;
    const err = e as Error;
    log.error({
      entityType: input.entityType,
      entityId: input.entityId,
      actionType: input.actionType,
      performedBy: input.performedBy,
      error: err.message,
    }, 'audit_write_failed');
    if (env.STRICT_AUDIT) throw e;
  }
}

function toObjectId(id: string): Types.ObjectId {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : new Types.ObjectId();
}

/** Strip fields that must never land in audit snapshots (tokens, raw payloads, vectors). */
function redact(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const clone: Record<string, unknown> = { ...src };
  for (const key of ['tokenRef', 'rawPayload', 'rawSourcePayload', 'embedding', '__v']) {
    if (key in clone) delete clone[key];
  }
  return clone;
}
