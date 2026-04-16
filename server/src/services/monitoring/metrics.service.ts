// ═══════════════════════════════════════════════════════════
// In-memory runtime counters for the monitoring dashboard.
//
// Not a durable metric system — values reset on process restart.
// Matches the existing single-instance architecture (same as the
// notifications ring buffer). When we scale out, swap for Redis
// or a real time-series store; the call sites below stay stable.
//
// What we count:
//   - duplicatePhoneEvents  — ConflictError on ExternalCandidate create
//   - notOwnerAttempts      — ForbiddenError('not_owner') from assertOwnership
//   - alreadySendingErrors  — sendProposal claim race rejections
// ═══════════════════════════════════════════════════════════

export interface CountersSnapshot {
  duplicatePhoneEvents: number;
  notOwnerAttempts: number;
  alreadySendingErrors: number;
  sendBlockedSafeModeCount: number;
  startedAt: string;
}

const counters = {
  duplicatePhoneEvents: 0,
  notOwnerAttempts: 0,
  alreadySendingErrors: 0,
  sendBlockedSafeModeCount: 0,
};
const startedAt = new Date().toISOString();

// ── Recent runtime error ring buffer ─────────────────────
// Populated alongside counter increments. Drives the "ERROR"
// class of events in /api/monitoring/events.
const MAX_ERROR_EVENTS = 100;

export interface RuntimeErrorEvent {
  id: string;
  kind: 'duplicate_phone' | 'not_owner' | 'already_sending' | 'send_blocked_safe_mode';
  at: string;
  metadata?: Record<string, unknown>;
}

const errorEvents: RuntimeErrorEvent[] = [];

function pushError(kind: RuntimeErrorEvent['kind'], metadata?: Record<string, unknown>): void {
  errorEvents.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    at: new Date().toISOString(),
    metadata,
  });
  if (errorEvents.length > MAX_ERROR_EVENTS) errorEvents.length = MAX_ERROR_EVENTS;
}

export function recordDuplicatePhone(metadata?: Record<string, unknown>): void {
  counters.duplicatePhoneEvents += 1;
  pushError('duplicate_phone', metadata);
}

export function recordNotOwnerAttempt(metadata?: Record<string, unknown>): void {
  counters.notOwnerAttempts += 1;
  pushError('not_owner', metadata);
}

export function recordAlreadySending(metadata?: Record<string, unknown>): void {
  counters.alreadySendingErrors += 1;
  pushError('already_sending', metadata);
}

export function recordSendBlockedSafeMode(metadata?: Record<string, unknown>): void {
  counters.sendBlockedSafeModeCount += 1;
  pushError('send_blocked_safe_mode', metadata);
}

export function getCounters(): CountersSnapshot {
  return { ...counters, startedAt };
}

export function getRecentErrorEvents(limit = 30): RuntimeErrorEvent[] {
  return errorEvents.slice(0, limit);
}
