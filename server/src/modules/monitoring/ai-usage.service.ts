// ═══════════════════════════════════════════════════════════
// ShadchanAI — AI Usage & Spend Report
//
// Aggregates the append-only AIRequest log into "how much is this
// API key costing us": totals, per-model, per-request-type, and a
// per-day series — each with an estimated USD cost from the pricing
// table. Powers the "עלויות AI" panel in Settings/Monitoring.
//
// Estimates only (list prices × logged tokens). Requests whose model
// has no pricing entry are counted with cost=null and surfaced under
// `unpricedRequests` so a gap reads as "unpriced", never as free.
// Note: the AIRequest log has a 90-day TTL — reports beyond that
// window are structurally empty.
// ═══════════════════════════════════════════════════════════

import { AIRequest } from '../../models/index.js';
import { estimateCostUsd } from '../../services/ai/ai.pricing.js';
import { aiBudgetSnapshot } from '../../services/ai/ai.service.js';

interface UsageBucket {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  unpricedRequests: number;
}

export interface AIUsageReport {
  days: number;
  totals: UsageBucket;
  byModel: Array<UsageBucket & { provider: string; model: string }>;
  byRequestType: Array<UsageBucket & { requestType: string }>;
  byDay: Array<UsageBucket & { day: string }>;
  budget: { limit: number; usedToday: number; day: string };
}

function emptyBucket(): UsageBucket {
  return { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0, unpricedRequests: 0 };
}

function fold(bucket: UsageBucket, row: {
  count: number; failures: number; inputTokens: number; outputTokens: number; cost: number | null;
}): void {
  bucket.requests += row.count;
  bucket.failures += row.failures;
  bucket.inputTokens += row.inputTokens;
  bucket.outputTokens += row.outputTokens;
  if (row.cost === null) bucket.unpricedRequests += row.count;
  else bucket.estCostUsd += row.cost;
}

export async function buildAIUsageReport(days: number): Promise<AIUsageReport> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // One aggregation, grouped at the finest grain we report (model ×
  // requestType × day); the coarser views are folded in JS — the row
  // count is tiny (models × types × days).
  const rows = await AIRequest.aggregate<{
    _id: { provider: string; model: string; requestType: string; day: string };
    count: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
  }>([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: {
          provider: '$provider',
          model: '$modelId',
          requestType: '$requestType',
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        },
        count: { $sum: 1 },
        failures: { $sum: { $cond: ['$success', 0, 1] } },
        inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
        outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
      },
    },
  ]).exec();

  const totals = emptyBucket();
  const byModelMap = new Map<string, UsageBucket & { provider: string; model: string }>();
  const byTypeMap = new Map<string, UsageBucket & { requestType: string }>();
  const byDayMap = new Map<string, UsageBucket & { day: string }>();

  for (const r of rows) {
    const cost = estimateCostUsd(r._id.model, r.inputTokens, r.outputTokens);
    const folded = {
      count: r.count,
      failures: r.failures,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cost,
    };

    fold(totals, folded);

    const modelKey = `${r._id.provider}:${r._id.model}`;
    let m = byModelMap.get(modelKey);
    if (!m) {
      m = { ...emptyBucket(), provider: r._id.provider, model: r._id.model };
      byModelMap.set(modelKey, m);
    }
    fold(m, folded);

    let t = byTypeMap.get(r._id.requestType);
    if (!t) {
      t = { ...emptyBucket(), requestType: r._id.requestType };
      byTypeMap.set(r._id.requestType, t);
    }
    fold(t, folded);

    let d = byDayMap.get(r._id.day);
    if (!d) {
      d = { ...emptyBucket(), day: r._id.day };
      byDayMap.set(r._id.day, d);
    }
    fold(d, folded);
  }

  return {
    days,
    totals,
    byModel: [...byModelMap.values()].sort((a, b) => b.estCostUsd - a.estCostUsd),
    byRequestType: [...byTypeMap.values()].sort((a, b) => b.requests - a.requests),
    byDay: [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    budget: await aiBudgetSnapshot(),
  };
}
