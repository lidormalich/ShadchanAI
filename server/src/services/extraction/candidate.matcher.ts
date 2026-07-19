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
  // A "degenerate" name — firstName === lastName — is a mis-extraction (the
  // surname was dropped into BOTH fields; see the "בוחניק בוחניק" fusion). Such
  // a name carries no real identity, so it must NEVER drive a match: every
  // person that shadchan posts would collapse into one card. Skip all
  // name-based tiers → treated as a new person (a duplicate is cheaper to merge
  // later than two people silently fused into one).
  if (isDegenerateName(profile.firstName, profile.lastName)) {
    return { strength: 'none', reason: 'degenerate name (first === last) — not used for matching' };
  }

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
    // Tier 1 is the ONLY tier that AUTO-MERGES (the orchestrator links it
    // silently). Since the phone is the shadchan's SHARED line, a name+phone
    // hit across a large age gap is two different people who share a surname,
    // not the same person — require the ages to be compatible before merging.
    // Incompatible → fall through to the age/name tiers, which route to the
    // duplicates review tab for a human decision instead of auto-linking.
    if (hit && agesCompatible(profile.age, hit.age)) {
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

  // ── Tier 2b: firstName + age (±1), NO last name on the incoming card ──
  // Single-first-name cards ("שם: שמרית", no surname) are extremely common in
  // WhatsApp groups and can't use any name+name tier — so a person reposted
  // across groups used to create a fresh candidate every time. When the incoming
  // card has no last name, a same-first-name + adjacent-age existing candidate
  // is enough to SUSPECT a duplicate. Reported 'weak' (lower confidence than a
  // full name+age hit) → the orchestrator routes it to the duplicates review
  // tab; it is NEVER auto-merged, since two different people can share a common
  // first name and age.
  if (profile.firstName && !profile.lastName && profile.age) {
    const hit = await ExternalCandidate.findOne({
      firstName: profile.firstName,
      age: { $gte: profile.age - 1, $lte: profile.age + 1 },
      status: { $ne: 'archived' },
    }).exec();
    if (hit) {
      return {
        strength: 'weak',
        candidate: hit,
        reason: `first-name+age match (no surname): ${profile.firstName} ~${profile.age}`,
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

/** True when the given name and surname are the same token — a mis-extraction
 *  (surname dropped into both fields), not a real identity. Exported so the
 *  merge-guard contract is unit-tested directly. */
export function isDegenerateName(first?: string, last?: string): boolean {
  if (!first || !last) return false;
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(first) === norm(last);
}

/** Ages are "compatible" for an auto-merge when either is unknown, or they are
 *  within a few years (posts get re-shared over time and a birthday may tick).
 *  A wide gap (e.g. 27 vs 35) means two different people who happen to share a
 *  surname + the shadchan's phone — never the same person. Exported so the
 *  merge-guard contract is unit-tested directly. */
export function agesCompatible(a?: number, b?: number): boolean {
  if (!a || !b) return true;
  return Math.abs(a - b) <= 2;
}
