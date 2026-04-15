import { describe, it, expect, beforeEach, vi } from 'vitest';

const envMock = { WA_SEND_PER_CHANNEL_PER_MIN: 20, WA_SEND_PER_USER_PER_MIN: 30 };
vi.mock('../../config/env.js', () => ({
  env: new Proxy({}, { get: (_t, prop) => (envMock as Record<string, unknown>)[prop as string] }),
}));

import { checkAndConsumeSendQuota, resetSendQuotas } from './send.rate-limiter.js';
import { BusinessRuleError } from '../../utils/errors.js';

describe('send.rate-limiter', () => {
  beforeEach(() => {
    resetSendQuotas();
  });

  it('allows calls under the limit', () => {
    for (let i = 0; i < 5; i++) {
      checkAndConsumeSendQuota({ channelId: 'ch_a', userId: `u_${i}` });
    }
  });

  it('blocks once the per-channel limit is exceeded', () => {
    const limit = envMock.WA_SEND_PER_CHANNEL_PER_MIN;
    for (let i = 0; i < limit; i++) {
      checkAndConsumeSendQuota({ channelId: 'ch_x', userId: `u_${i}` });
    }
    expect(() => checkAndConsumeSendQuota({ channelId: 'ch_x', userId: 'u_extra' }))
      .toThrow(BusinessRuleError);
  });

  it('blocks once the per-user limit is exceeded', () => {
    const limit = envMock.WA_SEND_PER_USER_PER_MIN;
    for (let i = 0; i < limit; i++) {
      checkAndConsumeSendQuota({ channelId: `ch_${i}`, userId: 'solo_user' });
    }
    expect(() => checkAndConsumeSendQuota({ channelId: 'ch_next', userId: 'solo_user' }))
      .toThrow(BusinessRuleError);
  });
});
