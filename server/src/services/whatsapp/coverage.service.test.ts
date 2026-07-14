import { describe, it, expect, vi } from 'vitest';

// The pure functions under test don't touch the DB, but the module
// imports the models barrel at load time — mock it so the test never
// compiles mongoose schemas.
vi.mock('../../models/index.js', () => ({
  Channel: {},
  ChatMapping: {},
  Message: {},
  CoverageReport: {},
}));

import { computeChatCoverage, resolveOfflineFrom } from './coverage.service.js';

const DAY_MS = 86_400_000;

describe('computeChatCoverage', () => {
  it('flags a normally-active chat that produced zero window messages', () => {
    const [entry] = computeChatCoverage(
      [{ chatJid: 'g1@g.us', chatName: 'שידוכים א', windowCount: 0, baselineCount: 70 }],
      2 * DAY_MS, // offline 2 days
      7,          // baseline week → 10/day → expected 20
    );
    expect(entry!.baselinePerDay).toBe(10);
    expect(entry!.expectedInWindow).toBe(20);
    expect(entry!.suspect).toBe(true);
  });

  it('does not flag a chat that was quiet in the baseline too', () => {
    const [entry] = computeChatCoverage(
      [{ chatJid: 'g2@g.us', windowCount: 0, baselineCount: 0 }],
      2 * DAY_MS,
    );
    expect(entry!.suspect).toBe(false);
  });

  it('does not flag a chat that delivered messages in the window', () => {
    const [entry] = computeChatCoverage(
      [{ chatJid: 'g3@g.us', windowCount: 5, baselineCount: 70 }],
      2 * DAY_MS,
    );
    expect(entry!.suspect).toBe(false);
  });

  it('does not flag when the window is too short to expect a message', () => {
    // 1/day baseline over a 30-minute window → expected ≈ 0.02 < 1
    const [entry] = computeChatCoverage(
      [{ chatJid: 'g4@g.us', windowCount: 0, baselineCount: 7 }],
      30 * 60_000,
    );
    expect(entry!.expectedInWindow).toBeLessThan(1);
    expect(entry!.suspect).toBe(false);
  });
});

describe('resolveOfflineFrom', () => {
  it('returns the most recent of lastDisconnectAt / lastInboundAt', () => {
    const disconnect = new Date('2026-07-12T10:00:00Z');
    const inbound = new Date('2026-07-12T12:00:00Z');
    expect(resolveOfflineFrom({ lastDisconnectAt: disconnect, lastInboundAt: inbound }))
      .toEqual(inbound);
    expect(resolveOfflineFrom({ lastDisconnectAt: inbound, lastInboundAt: disconnect }))
      .toEqual(inbound);
  });

  it('works when only one timestamp exists (hard-kill fallback)', () => {
    const inbound = new Date('2026-07-12T12:00:00Z');
    expect(resolveOfflineFrom({ lastInboundAt: inbound })).toEqual(inbound);
  });

  it('returns null on a never-connected channel', () => {
    expect(resolveOfflineFrom({})).toBeNull();
  });
});
