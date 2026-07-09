// ═══════════════════════════════════════════════════════════
// External-candidate profile completion — single source of truth
// for "which fields are still missing" and how to edit each one.
//
// Reused by:
//   - the candidates list "נדרש למלא פרטים" tab (labels only)
//   - the profile "השלמת פרטים" tab (renders an editable input per
//     missing field and saves only those, via the normal update API)
//
// Keeping ONE definition here means the "what's missing" rule can
// never drift between the list badge and the completion form.
// ═══════════════════════════════════════════════════════════

import { label } from '@/utils/labels';
import type { ExternalCandidate } from '@/types/domain';

export interface CompletionField {
  /** Primary candidate field this maps to (the 'name' field edits first+last). */
  key: 'gender' | 'name' | 'age' | 'city' | 'sectorGroup' | 'personalStatus' | 'availabilityStatus';
  label: string;
  type: 'text' | 'number' | 'select' | 'name';
  options?: { value: string; label: string }[];
  /** True when this field still needs filling on the given candidate. */
  missing: (c: ExternalCandidate) => boolean;
}

const opts = (category: string, values: string[]): { value: string; label: string }[] =>
  values.map((v) => ({ value: v, label: label(category, v) }));

// Order mirrors the list's original missing-fields order.
export const COMPLETION_FIELDS: CompletionField[] = [
  { key: 'gender', label: 'מין', type: 'select', options: opts('gender', ['male', 'female']), missing: (c) => !c.gender },
  { key: 'name', label: 'שם', type: 'name', missing: (c) => !`${c.firstName ?? ''}${c.lastName ?? ''}`.trim() },
  { key: 'age', label: 'גיל', type: 'number', missing: (c) => c.age == null },
  { key: 'city', label: 'עיר', type: 'text', missing: (c) => !c.city },
  { key: 'sectorGroup', label: 'מגזר', type: 'select', options: opts('sectorGroup', ['dati_leumi', 'haredi', 'dati', 'masorti', 'hardal', 'torani', 'other']), missing: (c) => !c.sectorGroup },
  { key: 'personalStatus', label: 'סטטוס אישי', type: 'select', options: opts('personalStatus', ['single', 'divorced', 'widowed', 'separated']), missing: (c) => !c.personalStatus },
  { key: 'availabilityStatus', label: 'זמינות', type: 'select', options: opts('availabilityStatus', ['available', 'dating', 'unavailable']), missing: (c) => c.availabilityStatus === 'unknown' },
];

/** The field descriptors still missing on this candidate (for the edit form). */
export function missingCompletionFields(c: ExternalCandidate): CompletionField[] {
  return COMPLETION_FIELDS.filter((f) => f.missing(c));
}

/** Just the Hebrew labels of the missing fields (for the list badges). */
export function missingFieldLabels(c: ExternalCandidate): string[] {
  return missingCompletionFields(c).map((f) => f.label);
}
