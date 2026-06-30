// ═══════════════════════════════════════════════════════════
// RejectionReason service — smart ingestion + dedup for the
// "why this pair didn't match" reasons bank.
//
// ingestReason() is the single write path. It is deliberately
// idempotent-ish:
//   - deterministic reasons (with a stableCode) upsert by code,
//     so identical engine reasons never fork.
//   - ai / operator reasons fuzzy-match existing entries in the
//     same category; a close enough match is reused (usage++),
//     otherwise a new entry is created.
//
// "Smart" here is intentionally cheap and deterministic: token
// Jaccard over a normalized form. No embeddings / no AI call —
// the bank can grow on every explain without extra latency or
// cost. (Embedding-based clustering is a possible future upgrade.)
// ═══════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { RejectionReason, type IRejectionReason } from '../../models/index.js';

// Two reasons in the same category whose normalized token sets
// overlap at least this much are treated as the same reason.
const SIMILARITY_THRESHOLD = 0.6;

/** Lowercase, strip Hebrew niqqud/cantillation + punctuation, collapse ws. */
export function normalizeReason(text: string): string {
  return text
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '') // Hebrew niqqud / cantillation marks
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(normalized: string): Set<string> {
  return new Set(normalized.split(' ').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function codeFromText(category: string, normalized: string): string {
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 10);
  return `${category}:${hash}`;
}

export interface IngestReasonInput {
  category: string;
  text: string;
  source: 'deterministic' | 'ai' | 'operator';
  performedBy?: string;
  /**
   * Stable code for deterministic reasons (e.g. a blocker code). When
   * present, ingestion upserts by this code exactly — no fuzzy match.
   */
  stableCode?: string;
}

export interface IngestReasonResult {
  reason: IRejectionReason;
  isNew: boolean;
}

export async function ingestReason(input: IngestReasonInput): Promise<IngestReasonResult> {
  const text = input.text.trim().slice(0, 500);
  if (!text) {
    throw new Error('ingestReason: empty reason text');
  }
  const normalizedText = normalizeReason(text);
  const createdBy = input.performedBy ? new Types.ObjectId(input.performedBy) : undefined;
  const now = new Date();

  // ── Deterministic: exact reuse by stable code ─────────────
  if (input.stableCode) {
    const existing = await RejectionReason.findOne({ code: input.stableCode }).exec();
    if (existing) {
      existing.usageCount += 1;
      existing.lastUsedAt = now;
      // Keep the canonical text fresh if the engine message changed.
      existing.text = text;
      existing.normalizedText = normalizedText;
      await existing.save();
      return { reason: existing, isNew: false };
    }
    const created = await RejectionReason.create({
      code: input.stableCode,
      category: input.category,
      text,
      normalizedText,
      source: input.source,
      usageCount: 1,
      lastUsedAt: now,
      createdBy,
    });
    return { reason: created, isNew: true };
  }

  // ── AI / operator: fuzzy dedup within the category ────────
  const candidates = await RejectionReason.find({ category: input.category })
    .select('normalizedText')
    .lean()
    .exec();

  const incomingTokens = tokenize(normalizedText);
  let bestId: Types.ObjectId | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = jaccard(incomingTokens, tokenize(candidate.normalizedText));
    if (score > bestScore) {
      bestScore = score;
      bestId = candidate._id as Types.ObjectId;
    }
  }

  if (bestId && bestScore >= SIMILARITY_THRESHOLD) {
    const updated = await RejectionReason.findByIdAndUpdate(
      bestId,
      { $inc: { usageCount: 1 }, $set: { lastUsedAt: now } },
      { new: true },
    ).exec();
    if (updated) return { reason: updated, isNew: false };
  }

  const created = await RejectionReason.create({
    code: codeFromText(input.category, normalizedText),
    category: input.category,
    text,
    normalizedText,
    source: input.source,
    usageCount: 1,
    lastUsedAt: now,
    createdBy,
  });
  return { reason: created, isNew: true };
}

/** Best-effort batch ingest. Never throws — bank growth must never
 *  break the explain flow it piggybacks on. */
export async function ingestReasons(
  inputs: IngestReasonInput[],
): Promise<IngestReasonResult[]> {
  const results: IngestReasonResult[] = [];
  for (const input of inputs) {
    try {
      results.push(await ingestReason(input));
    } catch {
      /* swallow — advisory metadata only */
    }
  }
  return results;
}

export interface ListReasonsQuery {
  category?: string;
  limit?: number;
}

export async function listReasons(query: ListReasonsQuery = {}): Promise<IRejectionReason[]> {
  const filter: Record<string, unknown> = {};
  if (query.category) filter['category'] = query.category;
  return RejectionReason.find(filter)
    .sort({ usageCount: -1, lastUsedAt: -1 })
    .limit(Math.min(query.limit ?? 200, 500))
    .lean()
    .exec() as unknown as IRejectionReason[];
}
