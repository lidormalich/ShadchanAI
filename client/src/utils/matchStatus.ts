// Match-suggestion statuses that are dead-ends: the suggestion is over.
// Shared so every surface (external + internal profiles, counters, action
// gates) agrees on what counts as a live vs. finished suggestion.
export const TERMINAL_MATCH_STATUSES = new Set<string>([
  'closed',
  'expired',
  'declined_side_a',
  'declined_side_b',
]);

/** True when the suggestion is finished (no live actions, not an active count). */
export function isTerminalMatchStatus(status: string | undefined): boolean {
  return !!status && TERMINAL_MATCH_STATUSES.has(status);
}
