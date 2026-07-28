// ═══════════════════════════════════════════════════════════
// Discovery vocabulary — the ONLY fields/values the public trait
// wizard may ask about, and the Hebrew labels the public page sees.
//
// This is the trust boundary for the AI-generated wizard: the AI
// picks phrasing and which of these questions to ask — it can NEVER
// invent a field or a value. /traits submissions are re-validated
// against this vocabulary server-side regardless of what the wizard
// displayed.
//
// No new source of truth: values come from shared enums; labels from
// the embedding serializer's Hebrew maps.
// ═══════════════════════════════════════════════════════════

import { Region, SectorGroup } from '@shadchanai/shared';
import {
  SECTOR_GROUP_HE,
  LIFESTYLE_TONE_HE,
  RELIGIOUS_STYLE_HE,
  STUDY_WORK_HE,
} from '../../services/embedding/profile.serializer.js';
import type {
  IDiscoveryWizard,
  IDiscoveryWizardQuestion,
} from './discovery-session.model.js';

export const REGION_HE: Record<Region, string> = {
  north: 'צפון',
  haifa_krayot: 'חיפה והקריות',
  sharon: 'השרון',
  gush_dan: 'גוש דן',
  jerusalem: 'ירושלים והסביבה',
  shfela: 'שפלה',
  south: 'דרום',
  yosh: 'יהודה ושומרון',
};

// traitPicks slots a wizard question may map onto. `soft:<field>`
// questions land in traitPicks.softPreferences with that field name.
export const WIZARD_MAPS_TO = [
  'ageRange',
  'regions',
  'openness.openToOtherSectors',
  'openness.openToDivorced',
  'openness.openToWithChildren',
  'openness.openToLongDistance',
  'soft:sectorGroup',
  'soft:lifestyleTone',
  'soft:religiousStyle',
  'soft:studyWorkDirection',
  'freeText',
] as const;
export type WizardMapsTo = (typeof WIZARD_MAPS_TO)[number];

// Allowed option values per soft-preference field (validated on submit).
export const SOFT_FIELD_VALUES: Record<string, Record<string, string>> = {
  sectorGroup: SECTOR_GROUP_HE,
  lifestyleTone: LIFESTYLE_TONE_HE,
  religiousStyle: RELIGIOUS_STYLE_HE,
  studyWorkDirection: STUDY_WORK_HE,
};

const YES_NO_OPTIONS = [
  { value: 'yes', label: 'כן, פתוח/ה לזה' },
  { value: 'no', label: 'פחות מתאים לי' },
];

function optionsFromMap(map: Record<string, string>): Array<{ value: string; label: string }> {
  return Object.entries(map).map(([value, label]) => ({ value, label }));
}

/**
 * The fixed fallback wizard, used when the AI wizard is disabled,
 * over budget, or fails. Age bounds are seeded from the candidate's
 * existing agePreferences so the slider opens in a sensible spot.
 */
export function buildStaticWizard(internal: {
  agePreferences?: { min?: number; max?: number };
  gender?: string;
}): IDiscoveryWizard {
  const questions: IDiscoveryWizardQuestion[] = [
    {
      id: 'age',
      question: 'איזה טווח גילאים מתאים לך?',
      type: 'range',
      mapsTo: 'ageRange',
      options: [
        { value: String(internal.agePreferences?.min ?? 20), label: 'מגיל' },
        { value: String(internal.agePreferences?.max ?? 35), label: 'עד גיל' },
      ],
    },
    {
      id: 'regions',
      question: 'באילו אזורים בארץ היית רוצה שההצעות יגורו?',
      type: 'multi',
      mapsTo: 'regions',
      options: optionsFromMap(REGION_HE),
    },
    {
      id: 'open_divorced',
      question: 'האם הצעה שהייתה נשואה בעבר יכולה להתאים לך?',
      type: 'single',
      mapsTo: 'openness.openToDivorced',
      options: YES_NO_OPTIONS,
    },
    {
      id: 'lifestyle',
      question: 'איזה סגנון חיים דתי הכי מתאים למה שאת/ה מחפש/ת?',
      type: 'multi',
      mapsTo: 'soft:lifestyleTone',
      options: optionsFromMap(LIFESTYLE_TONE_HE),
    },
    {
      id: 'free_text',
      question: 'משהו חשוב לך שלא שאלנו? (לא חובה)',
      type: 'single',
      mapsTo: 'freeText',
      options: [],
    },
  ];
  return { source: 'static', questions, generatedAt: new Date() };
}

/**
 * Validates a submitted wizard answer set into clean traitPicks.
 * Everything unknown is silently dropped — the vocabulary is the law,
 * not whatever the client (or a tampered request) claims was asked.
 */
export function sanitizeTraitPicks(raw: {
  ageMin?: unknown; ageMax?: unknown;
  regions?: unknown;
  openness?: Record<string, unknown>;
  softPreferences?: Array<{ field?: unknown; value?: unknown; importance?: unknown }>;
  freeText?: unknown;
}): {
  ageMin?: number; ageMax?: number;
  regions?: string[];
  openness?: Record<string, boolean>;
  softPreferences?: Array<{ field: string; value: string; importance: string }>;
  freeText?: string;
} {
  const out: ReturnType<typeof sanitizeTraitPicks> = {};

  const ageMin = Number(raw.ageMin);
  const ageMax = Number(raw.ageMax);
  if (Number.isFinite(ageMin) && ageMin >= 16 && ageMin <= 120) out.ageMin = Math.round(ageMin);
  if (Number.isFinite(ageMax) && ageMax >= 16 && ageMax <= 120) out.ageMax = Math.round(ageMax);
  if (out.ageMin !== undefined && out.ageMax !== undefined && out.ageMin > out.ageMax) {
    [out.ageMin, out.ageMax] = [out.ageMax, out.ageMin];
  }

  if (Array.isArray(raw.regions)) {
    const valid = raw.regions
      .filter((r): r is Region => typeof r === 'string' && r in REGION_HE);
    if (valid.length > 0) out.regions = [...new Set(valid)];
  }

  if (raw.openness && typeof raw.openness === 'object') {
    const openness: Record<string, boolean> = {};
    for (const key of ['openToOtherSectors', 'openToDivorced', 'openToWithChildren', 'openToLongDistance']) {
      const v = raw.openness[key];
      if (typeof v === 'boolean') openness[key] = v;
    }
    if (Object.keys(openness).length > 0) out.openness = openness;
  }

  if (Array.isArray(raw.softPreferences)) {
    const prefs: Array<{ field: string; value: string; importance: string }> = [];
    for (const p of raw.softPreferences.slice(0, 12)) {
      const fieldName = typeof p.field === 'string' ? p.field : '';
      const allowed = SOFT_FIELD_VALUES[fieldName];
      if (!allowed) continue;
      const value = typeof p.value === 'string' ? p.value : '';
      if (!(value in allowed)) continue;
      const importance = typeof p.importance === 'string'
        && ['must_have', 'important', 'nice_to_have', 'flexible'].includes(p.importance)
        ? p.importance : 'important';
      prefs.push({ field: fieldName, value, importance });
    }
    if (prefs.length > 0) out.softPreferences = prefs;
  }

  if (typeof raw.freeText === 'string' && raw.freeText.trim().length > 0) {
    out.freeText = raw.freeText.trim().slice(0, 300);
  }

  return out;
}

/** Sanity guard for AI-generated wizard questions (see discovery-ai.service). */
export function isValidWizardQuestion(q: IDiscoveryWizardQuestion): boolean {
  if (!(WIZARD_MAPS_TO as readonly string[]).includes(q.mapsTo)) return false;
  if (q.mapsTo.startsWith('soft:')) {
    const allowed = SOFT_FIELD_VALUES[q.mapsTo.slice('soft:'.length)];
    if (!allowed) return false;
    return q.options.every((o) => o.value in allowed);
  }
  if (q.mapsTo === 'regions') {
    return q.options.every((o) => o.value in REGION_HE);
  }
  if (q.mapsTo.startsWith('openness.')) {
    return q.options.every((o) => o.value === 'yes' || o.value === 'no');
  }
  return true; // ageRange / freeText — options are free-form bounds / empty
}

// Starter reject-reason chips so the sheet is never empty on a fresh
// DB; merged with the most-used bank entries at serve time.
export const STARTER_REJECT_CHIPS = [
  'הבדל גיל',
  'מרחק גיאוגרפי',
  'סגנון דתי שונה',
  'לא התחברתי לתיאור',
  'רקע תעסוקתי',
  'שלב חיים שונה',
];
