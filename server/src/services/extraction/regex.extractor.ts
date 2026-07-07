// ═══════════════════════════════════════════════════════════
// ShadchanAI — Regex Profile Extractor
//
// Deterministic pre-parse of a Hebrew WhatsApp profile card into
// structured fields. Runs BEFORE any LLM call.
//
// Guarantees:
//   - Pure function (no I/O, no DB).
//   - Never throws on messy input — returns partial result.
//   - isTemplateForm=true marks blank forms (all labeled lines empty).
//   - confidence is a rough 0..1 heuristic; downstream decides the
//     threshold for "good enough to skip AI".
// ═══════════════════════════════════════════════════════════

import type { Gender, PersonalStatus, SectorGroup } from '@shadchanai/shared';
import {
  resolveLabel,
  parseAge,
  parseHeight,
  parsePersonalStatus,
  parseSectorGroup,
  parseAgeRange,
  parsePhones,
  parseName,
  inferGender,
  stripDecorations,
  type FieldKey,
} from './templates.js';

export interface ExtractedProfile {
  firstName?: string;
  lastName?: string;
  gender?: Gender;
  age?: number;
  ageText?: string;
  height?: number;
  city?: string;
  edah?: string;
  sectorGroup?: SectorGroup;
  religiousLevelText?: string;
  personalStatus?: PersonalStatus;
  occupation?: string;
  about?: string;
  family?: string;
  service?: string;
  yeshiva?: string;
  whatSeeking?: string;
  seekingAgeMin?: number;
  seekingAgeMax?: number;
  contactPhones?: string[];
}

export interface RegexExtractionResult {
  profile: ExtractedProfile;
  isLikelyProfile: boolean;
  isTemplateForm: boolean;
  matchedFields: FieldKey[];
  confidence: number;
  unmatchedLines: string[];
}

// Fields that "count" as core profile signal for confidence.
const CORE_FIELDS: FieldKey[] = ['name', 'age', 'height', 'city', 'sector', 'edah', 'occupation'];

export function extractProfileFromText(rawText: string): RegexExtractionResult {
  const profile: ExtractedProfile = {};
  const matchedFields = new Set<FieldKey>();
  const unmatchedLines: string[] = [];

  const lines = rawText.split(/\r?\n/);
  let labeledLines = 0;
  let labeledEmptyLines = 0;

  for (const rawLine of lines) {
    const hit = resolveLabel(rawLine);
    if (!hit) {
      const clean = stripDecorations(rawLine);
      if (clean) unmatchedLines.push(clean);
      continue;
    }

    labeledLines += 1;
    if (!hit.value) {
      // A colon-form empty ("גיל:") is a blank fill-in template field. A bold
      // section-header ("*על עצמי*") is NOT — its value sits on the next line
      // and is read as free text — so it must not trip template detection.
      if (!hit.viaBold) labeledEmptyLines += 1;
      continue;
    }

    applyField(profile, hit.field, hit.value);
    matchedFields.add(hit.field);
  }

  // Contact phones — scan the whole text regardless of labels, since
  // they often appear on their own line with no label.
  const phones = parsePhones(rawText);
  if (phones.length > 0) {
    profile.contactPhones = phones;
    matchedFields.add('phone');
  }

  // Gender: last-pass inference across the whole text + status we
  // already parsed.
  const genderInf = inferGender(rawText, profile.personalStatus);
  if (genderInf.gender) profile.gender = genderInf.gender;

  // Template-form detection: if >= 3 labeled lines had no value, treat
  // as a blank form a shadchan sent to be filled in, NOT a real profile.
  const isTemplateForm = labeledLines >= 3 && labeledEmptyLines >= 3 && labeledEmptyLines / labeledLines >= 0.5;

  // Confidence scoring
  const coreHits = CORE_FIELDS.filter((f) => matchedFields.has(f)).length;
  let confidence = 0;
  if (matchedFields.has('name') && coreHits >= 5) confidence = 0.95;
  else if (matchedFields.has('name') && coreHits >= 3) confidence = 0.8;
  else if (coreHits >= 4) confidence = 0.65;
  else if (coreHits >= 2) confidence = 0.5;
  else if (matchedFields.size > 0) confidence = 0.25;
  if (isTemplateForm) confidence = 0;

  const isLikelyProfile = !isTemplateForm && matchedFields.size >= 3 && (matchedFields.has('name') || coreHits >= 3);

  return {
    profile,
    isLikelyProfile,
    isTemplateForm,
    matchedFields: [...matchedFields],
    confidence,
    unmatchedLines,
  };
}

// ── Per-field application ────────────────────────────────

function applyField(profile: ExtractedProfile, field: FieldKey, value: string): void {
  switch (field) {
    case 'name': {
      const { firstName, lastName } = parseName(value);
      if (firstName) profile.firstName = firstName;
      if (lastName) profile.lastName = lastName;
      return;
    }
    case 'age': {
      const { age, ageText } = parseAge(value);
      if (age) profile.age = age;
      if (ageText) profile.ageText = ageText;
      return;
    }
    case 'height': {
      const h = parseHeight(value);
      if (h) profile.height = h;
      return;
    }
    case 'city':
      profile.city = value;
      return;
    case 'edah':
      profile.edah = value;
      return;
    case 'sector': {
      profile.religiousLevelText = value;
      const sg = parseSectorGroup(value);
      if (sg) profile.sectorGroup = sg;
      return;
    }
    case 'status': {
      const ps = parsePersonalStatus(value);
      if (ps) profile.personalStatus = ps;
      return;
    }
    case 'occupation':
      profile.occupation = value;
      return;
    case 'about':
      profile.about = appendParagraph(profile.about, value);
      return;
    case 'family':
      profile.family = value;
      return;
    case 'service':
      profile.service = value;
      return;
    case 'yeshiva':
      profile.yeshiva = value;
      return;
    case 'seeking':
      profile.whatSeeking = appendParagraph(profile.whatSeeking, value);
      return;
    case 'ageRange': {
      const range = parseAgeRange(value);
      if (range) {
        if (range.min !== undefined) profile.seekingAgeMin = range.min;
        if (range.max !== undefined) profile.seekingAgeMax = range.max;
      }
      return;
    }
    case 'maxAge': {
      // "עד איזה גיל מתפשר: 31" — the label already means an upper bound, so
      // a bare number is the seeking-age ceiling.
      const m = value.match(/\d{1,2}/);
      const n = m ? Number(m[0]) : NaN;
      if (!Number.isNaN(n) && n >= 15 && n <= 99) profile.seekingAgeMax = n;
      return;
    }
    case 'photos':
    case 'phone':
    case 'selfIntro':
      return;
  }
}

function appendParagraph(existing: string | undefined, next: string): string {
  return existing ? `${existing}\n${next}` : next;
}
