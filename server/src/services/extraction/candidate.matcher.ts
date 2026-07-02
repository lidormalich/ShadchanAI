// ═══════════════════════════════════════════════════════════
// ShadchanAI — Candidate Matcher
//
// Given a profile extracted from a WhatsApp message, decide
// whether it refers to an ExternalCandidate we already have.
//
// Match tiers (first hit wins — we do NOT merge signals across tiers):
//   1. EXACT    — firstName + lastName AND contact phone both match.
//   2. STRONG   — firstName + lastName + age within ±1 year.
//   3. WEAK     — firstName + lastName (no age context).
//   4. NONE     — no plausible existing candidate.
//
// IMPORTANT — phone is NOT an identity signal on its own. In shidduch
// posts the number is almost always the SHADCHAN's "inquiries" line
// (טלפון לבירורים), shared across many different candidates that person
// posts. Matching on phone alone therefore collapses distinct people
// into one record — the opposite of what we want. Policy (operator's
// call): prefer a duplicate over a miss. So the name is the identity
// key; phone only CORROBORATES a name match (tier 1), never merges by
// itself. Real duplicates are cheaper to merge later than lost profiles.
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
  // ── Tier 1: firstName + lastName + phone (all three) ──
  // Phone corroborates a NAME match — it is never used alone (it is the
  // shadchan's shared inquiries line, not the candidate's identity).
  const rawPhones = profile.contactPhones ?? [];
  const normalized = normalizePhones(rawPhones);
  const phoneOr = [
    ...(normalized.length > 0 ? [{ contactPhoneNormalized: { $in: normalized } }] : []),
    ...(rawPhones.length > 0 ? [{ contactPhone: { $in: rawPhones } }] : []),
  ];
  if (profile.firstName && profile.lastName && phoneOr.length > 0) {
    const hit = await ExternalCandidate.findOne({
      firstName: profile.firstName,
      lastName: profile.lastName,
      $or: phoneOr,
      status: { $ne: 'archived' },
    }).exec();
    if (hit) {
      return {
        strength: 'exact',
        candidate: hit,
        reason: `name+phone match: ${profile.firstName} ${profile.lastName}`,
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
