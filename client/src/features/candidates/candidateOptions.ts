// Shared mappers: domain candidates → CandidatePicker options.
// Keeps the "how a candidate row looks in a picker" decision (name
// fallback, photo-approval gate, meta line format) in one place.

import { label } from '@/utils/labels';
import type { CandidateOption } from '@/components/ui/CandidatePicker';
import type { ExternalCandidate, InternalCandidate } from '@/types/domain';

export function ageFromDob(dob?: string): number | null {
  if (!dob) return null;
  const age = Math.floor((Date.now() - new Date(dob).getTime()) / 3.15576e10);
  return Number.isFinite(age) && age > 0 ? age : null;
}

function metaLine(age: number | null | undefined, city?: string, sectorGroup?: string): string {
  return [age ?? null, city ?? null, sectorGroup ? label('sectorGroup', sectorGroup) : null]
    .filter(Boolean)
    .join(' · ');
}

export function internalToOption(c: InternalCandidate): CandidateOption {
  return {
    id: c._id,
    name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'ללא שם',
    // Operator picked photoApproved as the display gate everywhere else.
    photoUrl: c.photoApproved ? c.photoUrl : undefined,
    meta: metaLine(ageFromDob(c.dateOfBirth), c.city, c.sectorGroup),
  };
}

export function externalToOption(c: ExternalCandidate): CandidateOption {
  return {
    id: c._id,
    name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'ללא שם',
    photoUrl: c.photoUrl,
    meta: metaLine(typeof c.age === 'number' ? c.age : null, c.city, c.sectorGroup),
  };
}
