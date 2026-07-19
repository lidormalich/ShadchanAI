import { describe, it, expect } from 'vitest';
import { MessageExtractionStatus } from '@shadchanai/shared';
import { nextRetryCount, MAX_EXTRACTION_RETRIES } from './orchestrator.js';

// Regression guard: a create/save that fails with a permanent (deterministic)
// error must NOT loop on the AI forever. It has to jump straight to the retry
// cap so the reconciler stops re-enqueuing it and it surfaces in the
// manual-entry ("failed candidates") queue immediately.
describe('nextRetryCount', () => {
  it('leaves the count untouched for a non-failed outcome', () => {
    expect(nextRetryCount(MessageExtractionStatus.CREATED_NEW, 2)).toBe(2);
    expect(nextRetryCount(MessageExtractionStatus.NEEDS_REVIEW, 0)).toBe(0);
    expect(nextRetryCount(MessageExtractionStatus.MATCHED_EXISTING, 1)).toBe(1);
  });

  it('increments by one for a transient failure (retried until the cap)', () => {
    expect(nextRetryCount(MessageExtractionStatus.FAILED, 0)).toBe(1);
    expect(nextRetryCount(MessageExtractionStatus.FAILED, 2)).toBe(3);
  });

  it('jumps a permanent failure straight to the cap (no wasted retries)', () => {
    expect(nextRetryCount(MessageExtractionStatus.FAILED, 0, true)).toBe(MAX_EXTRACTION_RETRIES);
  });

  it('a permanent failure is immediately exhausted (>= cap)', () => {
    const rc = nextRetryCount(MessageExtractionStatus.FAILED, 0, true);
    expect(rc >= MAX_EXTRACTION_RETRIES).toBe(true);
  });
});
