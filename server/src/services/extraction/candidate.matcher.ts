// ═══════════════════════════════════════════════════════════
// ShadchanAI — Candidate Matcher
//
// Given a profile extracted from a WhatsApp message, decide
// whether it refers to an ExternalCandidate we already have.
//
// Match tiers (first hit wins — we do NOT merge signals across tiers):
//   1. EXACT    — normalized contactPhone match. Highest confidence.
//   2. STRONG   — firstName + lastName + age within ±1 year. Age is
//                 a cheap tiebreaker when two people share a name.
//   3. WEAK     — firstName + lastName (no age context). Downstream
//                 treats this as "probably — ask a human to confirm".
//   4. NONE     — no plausible existing candidate.
//
// The matcher does NOT decide to update vs create — that's the
// orchestrator's call. It only reports what it found.
// ═══════════════════════════════════════════════════════════

import { ExternalCandidate, type IExternalCandidate } from '../../models/index.js';
import type { ExtractedProfile } from './regex.extractor.js';
import { normalizePhones } from '../../utils/phone.js';

export type MatchStrength = 'exact' | 'strong' | 'weak' | 'none';

export interface MatchResult {
  strength: MatchStrength;
  candidate?: IExternalCandidate;
  reason: string;
}

export async function findExistingCandidate(profile: ExtractedProfile): Promise<MatchResult> {
  // ── Tier 1: contact phone (canonicalized) ─────────────
  // Canonical E.164 phone is the sharpest id we have. We match
  // against BOTH the legacy contactPhone (for backward-compat
  // with older rows that never had contactPhoneNormalized) AND
  // contactPhoneNormalized (the authoritative dedup key).
  const rawPhones = profile.contactPhones ?? [];
  const normalized = normalizePhones(rawPhones);
  if (rawPhones.length > 0 || normalized.length > 0) {
    const hit = await ExternalCandidate.findOne({
      $or: [
        ...(normalized.length > 0 ? [{ contactPhoneNormalized: { $in: normalized } }] : []),
        ...(rawPhones.length > 0 ? [{ contactPhone: { $in: rawPhones } }] : []),
      ],
      status: { $ne: 'archived' },
    }).exec();
    if (hit) {
      return {
        strength: 'exact',
        candidate: hit,
        reason: `phone match: ${hit.contactPhoneNormalized ?? hit.contactPhone}`,
      };
    }
  }

  // ── Tier 2: firstName + lastName + age (±1) ───────────
  if (profile.firstName && profile.lastName && profile.age) {
    const hit = await ExternalCandidate.findOne({
      firstName: profile.firstName,
      lastName: profile.lastName,
      age: { $gte: profile.age - 1, $lte: profile.age + 1 },
      status: { $ne: 'archived' },
    }).exec();
    if (hit) {
      return {
        strength: 'strong',
        candidate: hit,
        reason: `name+age match: ${profile.firstName} ${profile.lastName}, age ~${profile.age}`,
      };
    }
  }

  // ── Tier 3: firstName + lastName (name-only) ──────────
  if (profile.firstName && profile.lastName) {
    const hit = await ExternalCandidate.findOne({
      firstName: profile.firstName,
      lastName: profile.lastName,
      status: { $ne: 'archived' },
    }).exec();
    if (hit) {
      return {
        strength: 'weak',
        candidate: hit,
        reason: `name-only match: ${profile.firstName} ${profile.lastName}`,
      };
    }
  }

  return { strength: 'none', reason: 'no candidate matched' };
}
