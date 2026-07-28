// ═══════════════════════════════════════════════════════════
// Discovery card DTO — the ONLY candidate projection that crosses
// the public boundary.
//
// PII rules (deliberate, reviewed):
//   - NO name, NO phone, NO email, NO raw ids, NO source text.
//   - NO city — city+age+sector is identifying in small communities;
//     region is the coarsest useful location signal.
//   - Free text (occupation / summary) passes through a deterministic
//     sanitizer that strips the candidate's own name, phone numbers,
//     emails and URLs. Prefer aiEnrichment.summary (generated prose,
//     lowest leak risk) over raw `about`.
// ═══════════════════════════════════════════════════════════

import {
  SECTOR_GROUP_HE,
  SUB_SECTOR_HE,
  PERSONAL_STATUS_HE,
} from '../../services/embedding/profile.serializer.js';
import { REGION_HE } from './discovery-vocab.js';

export interface DiscoveryCardDTO {
  cardId: string;
  age?: number | undefined;
  regionLabel?: string | undefined;
  sectorGroupLabel?: string | undefined;
  subSectorLabel?: string | undefined;
  personalStatusLabel?: string | undefined;
  occupation?: string | undefined;
  educationLevel?: string | undefined;
  height?: number | undefined;
  summary?: string | undefined;
  /** Engine strengths (already Hebrew, non-identifying), max 3. */
  highlights: string[];
  hasPhoto: boolean;
}

// Israeli phone shapes (0501234567, 050-123-4567, +972 50 123 4567) —
// deliberately greedy: better to over-strip a digit run than leak a number.
const PHONE_RE = /(?:\+972[-\s]?|0)\d(?:[-\s]?\d){7,9}/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const URL_RE = /https?:\/\/\S+|www\.\S+/g;

/**
 * Deterministic PII scrub for free text shown on a public card.
 * Removes the candidate's own name tokens (word-boundary), phones,
 * emails and URLs. No AI — testable and predictable.
 */
export function sanitizeCardText(
  text: string | undefined,
  identity: { firstName?: string | undefined; lastName?: string | undefined },
  maxLen = 300,
): string | undefined {
  if (!text) return undefined;
  let out = text;

  for (const name of [identity.firstName, identity.lastName]) {
    const token = name?.trim();
    if (!token || token.length < 2) continue;
    // Hebrew has no \b for its letters — match on non-letter boundaries
    // (or string edges) instead, keeping prefixed forms like "ומיכל" safe.
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`(^|[^\\p{L}])${escaped}(?=$|[^\\p{L}])`, 'gu'),
      '$1',
    );
  }

  out = out
    .replace(PHONE_RE, '')
    .replace(EMAIL_RE, '')
    .replace(URL_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (out.length === 0) return undefined;
  return out.length > maxLen ? `${out.slice(0, maxLen - 1)}…` : out;
}

interface ExternalForCard {
  firstName?: string;
  lastName?: string;
  age?: number;
  region?: string;
  sectorGroup?: string;
  subSector?: string;
  personalStatus?: string;
  currentOccupation?: string;
  educationLevel?: string;
  height?: number;
  about?: string;
  aiEnrichment?: { summary?: string };
}

export function buildDiscoveryCardDTO(
  cardId: string,
  ext: ExternalForCard,
  strengths: string[],
  hasPhoto: boolean,
): DiscoveryCardDTO {
  const identity = { firstName: ext.firstName, lastName: ext.lastName };
  return {
    cardId,
    age: ext.age,
    regionLabel: ext.region ? REGION_HE[ext.region as keyof typeof REGION_HE] : undefined,
    sectorGroupLabel: ext.sectorGroup
      ? SECTOR_GROUP_HE[ext.sectorGroup as keyof typeof SECTOR_GROUP_HE] : undefined,
    subSectorLabel: ext.subSector
      ? SUB_SECTOR_HE[ext.subSector as keyof typeof SUB_SECTOR_HE] : undefined,
    personalStatusLabel: ext.personalStatus
      ? PERSONAL_STATUS_HE[ext.personalStatus as keyof typeof PERSONAL_STATUS_HE] : undefined,
    occupation: sanitizeCardText(ext.currentOccupation, identity, 80),
    educationLevel: sanitizeCardText(ext.educationLevel, identity, 60),
    height: ext.height,
    summary: sanitizeCardText(ext.aiEnrichment?.summary ?? ext.about, identity, 300),
    highlights: strengths.slice(0, 3),
    hasPhoto,
  };
}
