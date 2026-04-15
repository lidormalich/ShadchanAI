// In-process sliding-window rate limiter for outbound WhatsApp sends.
// Per-instance only — does not coordinate across processes/nodes.

import { env } from '../../config/env.js';
import { BusinessRuleError } from '../../utils/errors.js';

const WINDOW_MS = 60_000;

const channelWindow = new Map<string, number[]>();
const userWindow = new Map<string, number[]>();

function consume(map: Map<string, number[]>, key: string, limit: number, now: number): boolean {
  const arr = map.get(key) ?? [];
  const cutoff = now - WINDOW_MS;
  const pruned = arr.filter((t) => t > cutoff);
  if (pruned.length >= limit) {
    map.set(key, pruned);
    return false;
  }
  pruned.push(now);
  map.set(key, pruned);
  return true;
}

function peek(map: Map<string, number[]>, key: string, now: number): number {
  const arr = map.get(key) ?? [];
  const cutoff = now - WINDOW_MS;
  return arr.filter((t) => t > cutoff).length;
}

export interface SendQuotaInput {
  channelId: string;
  userId: string;
}

export function checkAndConsumeSendQuota(input: SendQuotaInput): void {
  const now = Date.now();
  const chCount = peek(channelWindow, input.channelId, now);
  if (chCount >= env.WA_SEND_PER_CHANNEL_PER_MIN) {
    throw new BusinessRuleError(
      `Channel send rate limit exceeded (${env.WA_SEND_PER_CHANNEL_PER_MIN}/min)`,
      { code: 'send_rate_limited', scope: 'channel', channelId: input.channelId },
    );
  }
  const usrCount = peek(userWindow, input.userId, now);
  if (usrCount >= env.WA_SEND_PER_USER_PER_MIN) {
    throw new BusinessRuleError(
      `User send rate limit exceeded (${env.WA_SEND_PER_USER_PER_MIN}/min)`,
      { code: 'send_rate_limited', scope: 'user', userId: input.userId },
    );
  }
  consume(channelWindow, input.channelId, env.WA_SEND_PER_CHANNEL_PER_MIN, now);
  consume(userWindow, input.userId, env.WA_SEND_PER_USER_PER_MIN, now);
}

export function resetSendQuotas(): void {
  channelWindow.clear();
  userWindow.clear();
}
