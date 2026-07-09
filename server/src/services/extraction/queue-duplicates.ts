// ═══════════════════════════════════════════════════════════
// In-queue duplicate detection.
//
// The candidate matcher only compares a pending card to EXISTING
// candidates. When the same person was reposted several times and
// none is a candidate yet, those cards sit in the review queue
// unlinked. This groups the pending cards among THEMSELVES so the
// operator can merge same-person reposts into one candidate.
//
// Kept as a pure module (no I/O) so the grouping predicate is unit-
// testable in isolation.
// ═══════════════════════════════════════════════════════════

import { normalizeNamePart } from '../../utils/identity.js';
import { normalizePhones } from '../../utils/phone.js';
import type { ExtractedProfile } from './regex.extractor.js';

export interface PendingDuplicate {
  messageId: string;
  firstName?: string;
  lastName?: string;
  age?: number;
  city?: string;
  contactPhone?: string;
}

export interface DupSig {
  first: string;
  last: string;
  age?: number;
  city: string;
  phones: string[];
}

export function sigOf(profile: ExtractedProfile): DupSig {
  return {
    first: normalizeNamePart(profile.firstName),
    last: normalizeNamePart(profile.lastName),
    age: profile.age,
    city: normalizeNamePart(profile.city),
    phones: normalizePhones(profile.contactPhones ?? []),
  };
}

// Two queued cards are "the same person" when the FIRST name matches (identity
// anchor — a shared shadchan phone is NOT identity) AND at least one of
// age(±1) / a shared phone / same city corroborates it. Compatible last names
// only (one side may omit it). A SUGGESTION — the operator confirms the merge —
// so leaning inclusive is fine.
export function isSamePerson(a: DupSig, b: DupSig): boolean {
  const nameMatch = !!a.first && a.first === b.first && (!a.last || !b.last || a.last === b.last);
  if (!nameMatch) return false;
  const ageMatch = a.age != null && b.age != null && Math.abs(a.age - b.age) <= 1;
  const phoneMatch = a.phones.some((p) => b.phones.includes(p));
  const cityMatch = !!a.city && a.city === b.city;
  return ageMatch || phoneMatch || cityMatch;
}

/** Fill each row's `pendingDuplicates` with the other queued cards that look
 *  like the same person (union-find over the pairwise same-person predicate). */
export function attachPendingDuplicates(
  rows: Array<{ messageId: string; extractedFields: ExtractedProfile; pendingDuplicates: PendingDuplicate[] }>,
): void {
  const n = rows.length;
  if (n < 2) return;
  const sigs = rows.map((r) => sigOf(r.extractedFields));

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (isSamePerson(sigs[i]!, sigs[j]!)) {
        const ri = find(i), rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(i);
  }

  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    for (const i of idxs) {
      rows[i]!.pendingDuplicates = idxs
        .filter((j) => j !== i)
        .map((j) => {
          const f = rows[j]!.extractedFields;
          return {
            messageId: rows[j]!.messageId,
            firstName: f.firstName,
            lastName: f.lastName,
            age: f.age,
            city: f.city,
            contactPhone: f.contactPhones?.[0],
          };
        });
    }
  }
}
