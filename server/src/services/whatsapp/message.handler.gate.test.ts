import { describe, it, expect } from 'vitest';
import { ChannelRole, MessageDirection } from '@shadchanai/shared';
import { resolveIngestionGate } from './message.handler.js';

const base = {
  channelRole: ChannelRole.PROFILES_SOURCE,
  direction: MessageDirection.INBOUND,
} as const;

describe('resolveIngestionGate', () => {
  it('is not eligible for match_sending channels', () => {
    expect(
      resolveIngestionGate({
        ...base,
        channelRole: ChannelRole.MATCH_SENDING,
        effectiveRole: 'profiles_source',
        requireExplicitMapping: false,
      }),
    ).toBe('not_eligible');
  });

  it('is not eligible for outbound messages', () => {
    expect(
      resolveIngestionGate({
        ...base,
        direction: MessageDirection.OUTBOUND,
        effectiveRole: 'profiles_source',
        requireExplicitMapping: false,
      }),
    ).toBe('not_eligible');
  });

  it('always diverts an explicit "ignore" mapping (both modes)', () => {
    for (const requireExplicitMapping of [true, false]) {
      expect(
        resolveIngestionGate({ ...base, effectiveRole: 'ignore', requireExplicitMapping }),
      ).toBe('ignored_assigned_ignore');
    }
  });

  it('always diverts an explicit "match_sending" mapping (both modes)', () => {
    for (const requireExplicitMapping of [true, false]) {
      expect(
        resolveIngestionGate({ ...base, effectiveRole: 'match_sending', requireExplicitMapping }),
      ).toBe('ignored_match_sending');
    }
  });

  describe('REQUIRE_EXPLICIT_SOURCE_MAPPING = true (safe default)', () => {
    it('approves only an explicitly mapped profiles_source chat', () => {
      expect(
        resolveIngestionGate({ ...base, effectiveRole: 'profiles_source', requireExplicitMapping: true }),
      ).toBe('approved');
    });

    it('drops an unmapped chat (incl. every new sender first message)', () => {
      expect(
        resolveIngestionGate({ ...base, effectiveRole: undefined, requireExplicitMapping: true }),
      ).toBe('ignored_unmapped');
    });
  });

  describe('REQUIRE_EXPLICIT_SOURCE_MAPPING = false (the dead-flag fix)', () => {
    it('ingests an unmapped chat by default — the bug fix', () => {
      expect(
        resolveIngestionGate({ ...base, effectiveRole: undefined, requireExplicitMapping: false }),
      ).toBe('approved');
    });

    it('still ingests an explicit profiles_source chat', () => {
      expect(
        resolveIngestionGate({ ...base, effectiveRole: 'profiles_source', requireExplicitMapping: false }),
      ).toBe('approved');
    });
  });
});
