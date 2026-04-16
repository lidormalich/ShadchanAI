// ═══════════════════════════════════════════════════════════
// ShadchanAI — Realtime pub/sub (Phase 3).
//
// A tiny in-process EventEmitter-backed broker. Consumers attach
// via SSE (`/api/realtime/events`) and receive operational events
// published by services across the app. Deliberately minimal:
//
//   - no persistence / replay
//   - single Node.js instance only (matches the existing Baileys
//     single-instance assumption)
//   - no auth beyond the SSE route's requireAuth middleware
//
// When the system scales to multiple instances, swap the local
// emitter for Redis pub/sub — event shapes below stay stable.
// ═══════════════════════════════════════════════════════════

import { EventEmitter } from 'node:events';

export type RealtimeEventType =
  | 'conversation.updated'
  | 'extraction.needs_review'
  | 'match.updated'
  // Channel lifecycle: session_start, state_change, disconnect, etc.
  // Emitted by channel.service so UIs can refresh without polling.
  | 'channel.updated';

export interface RealtimeEvent<T = unknown> {
  type: RealtimeEventType;
  at: string;
  payload: T;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // many SSE clients may attach

export function publishRealtimeEvent<T>(type: RealtimeEventType, payload: T): void {
  const event: RealtimeEvent<T> = {
    type,
    at: new Date().toISOString(),
    payload,
  };
  emitter.emit('event', event);
}

export function subscribeRealtime(listener: (event: RealtimeEvent) => void): () => void {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}
