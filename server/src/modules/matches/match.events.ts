// ═══════════════════════════════════════════════════════════
// ShadchanAI — Match realtime events
//
// Thin wrapper so every match transition publishes a uniform
// realtime event. Shared by lifecycle, send, and create paths.
// ═══════════════════════════════════════════════════════════

import type { IMatchSuggestion } from '../../models/index.js';
import { publishRealtimeEvent } from '../../services/realtime/realtime.service.js';

export function publishMatchUpdate(
  doc: IMatchSuggestion,
  transition: string,
  extra?: Record<string, unknown>,
): void {
  publishRealtimeEvent('match.updated', {
    matchId: String(doc._id),
    status: doc.status,
    isDeferred: doc.isDeferred,
    transition,
    ...extra,
  });
}
