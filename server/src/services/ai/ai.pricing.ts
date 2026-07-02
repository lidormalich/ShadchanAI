// ═══════════════════════════════════════════════════════════
// ShadchanAI — AI Pricing Table
//
// USD per 1M tokens, per model. Used to turn the AIRequest token
// log into estimated spend for the monitoring dashboard.
//
// These are LIST prices, hardcoded on purpose: an estimate that's a
// few percent off is fine for "how much is this key costing us";
// exact billing lives with the provider. Update when prices change —
// unknown models degrade to null cost (tokens still counted).
// Prices verified 2026-07.
// ═══════════════════════════════════════════════════════════

export interface ModelPricing {
  /** USD per 1M input tokens */
  inputPerM: number;
  /** USD per 1M output tokens */
  outputPerM: number;
}

// Keys are matched by prefix (models often carry date suffixes like
// gpt-4o-mini-2024-07-18). Order matters: longest/most-specific first.
const PRICE_TABLE: Array<{ prefix: string; pricing: ModelPricing }> = [
  // ── OpenAI ──
  { prefix: 'gpt-4o-mini', pricing: { inputPerM: 0.15, outputPerM: 0.60 } },
  { prefix: 'gpt-4o', pricing: { inputPerM: 2.50, outputPerM: 10.00 } },
  { prefix: 'gpt-4.1-mini', pricing: { inputPerM: 0.40, outputPerM: 1.60 } },
  { prefix: 'gpt-4.1-nano', pricing: { inputPerM: 0.10, outputPerM: 0.40 } },
  { prefix: 'gpt-4.1', pricing: { inputPerM: 2.00, outputPerM: 8.00 } },
  { prefix: 'text-embedding-3-small', pricing: { inputPerM: 0.02, outputPerM: 0 } },
  { prefix: 'text-embedding-3-large', pricing: { inputPerM: 0.13, outputPerM: 0 } },
  // ── Groq (free tier in practice; paid tier list prices) ──
  { prefix: 'llama-3.3-70b', pricing: { inputPerM: 0.59, outputPerM: 0.79 } },
  { prefix: 'llama-3.1-8b', pricing: { inputPerM: 0.05, outputPerM: 0.08 } },
  { prefix: 'llama3-70b', pricing: { inputPerM: 0.59, outputPerM: 0.79 } },
  { prefix: 'mixtral-8x7b', pricing: { inputPerM: 0.24, outputPerM: 0.24 } },
];

export function pricingFor(modelId: string): ModelPricing | null {
  const m = modelId.toLowerCase();
  for (const row of PRICE_TABLE) {
    if (m.startsWith(row.prefix)) return row.pricing;
  }
  return null;
}

/**
 * Estimated USD cost for one request. Null when the model is unknown
 * (the caller should surface "unknown pricing" rather than $0.00 —
 * zero reads as free, null reads as unpriced).
 */
export function estimateCostUsd(
  modelId: string,
  inputTokens?: number,
  outputTokens?: number,
): number | null {
  const p = pricingFor(modelId);
  if (!p) return null;
  const inCost = ((inputTokens ?? 0) / 1_000_000) * p.inputPerM;
  const outCost = ((outputTokens ?? 0) / 1_000_000) * p.outputPerM;
  return inCost + outCost;
}
