import { describe, it, expect } from 'vitest';
import { isPermanentFailureReason } from './extraction.service.js';

// Guards the fallback classifier that routes records which failed BEFORE the
// persisted `permanentFailure` flag existed (e.g. the stuck "אורית" card) to
// the manual-entry page instead of leaving them requeuable forever.
describe('isPermanentFailureReason', () => {
  it('flags the length-cap validation error (the real "אורית" case)', () => {
    const reason =
      'ExternalCandidate validation failed: currentOccupation: Path `currentOccupation` ' +
      '(`מורה למתמטיקה. על עצמי: בחורה ...`, length 311) is longer than the maximum allowed length (200).';
    expect(isPermanentFailureReason(reason)).toBe(true);
  });

  it('flags enum / cast / required validation errors', () => {
    expect(isPermanentFailureReason('`x` is not a valid enum value for path `gender`.')).toBe(true);
    expect(isPermanentFailureReason('Cast to Number failed for value "abc"')).toBe(true);
    expect(isPermanentFailureReason('Path `firstName` is required.')).toBe(true);
  });

  it('does NOT flag transient failures (rate-limit / timeout)', () => {
    expect(isPermanentFailureReason('429 rate limit exceeded')).toBe(false);
    expect(isPermanentFailureReason('request timed out')).toBe(false);
    expect(isPermanentFailureReason('vision: bad decrypt')).toBe(false);
    expect(isPermanentFailureReason(undefined)).toBe(false);
  });
});
