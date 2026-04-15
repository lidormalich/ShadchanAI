// ═══════════════════════════════════════════════════════════
// ShadchanAI — Profile Extraction Templates
//
// Label dictionary + per-field value parsers for Hebrew profile
// cards that arrive on profiles_source WhatsApp channels.
//
// Goal: cheap deterministic pre-parse BEFORE any LLM call.
// Each profile message in the wild follows one of ~10 loose
// "templates" — labeled lines separated by `:` with optional
// emoji decorations. This module turns those lines into a
// canonical field map without any AI.
//
// Covers the 10 real samples provided by the operator (see
// regex.extractor.test.ts). Do NOT over-specialize here —
// new label variants should be added to LABEL_SYNONYMS rather
// than built into bespoke regex.
// ═══════════════════════════════════════════════════════════

import { Gender, PersonalStatus, SectorGroup } from '@shadchanai/shared';

// ── Canonical field keys ─────────────────────────────────

export type FieldKey =
  | 'name'
  | 'age'
  | 'height'
  | 'city'
  | 'edah'
  | 'sector'
  | 'status'
  | 'occupation'
  | 'about'
  | 'family'
  | 'service'
  | 'yeshiva'
  | 'seeking'
  | 'ageRange'
  | 'photos'
  | 'phone'
  | 'selfIntro';

// ── Label synonyms ───────────────────────────────────────
// Map Hebrew labels as they appear in the wild to a canonical
// key. Matching is case/whitespace insensitive and is done
// after emoji + punctuation stripping.

export const LABEL_SYNONYMS: Record<FieldKey, string[]> = {
  name: ['שם', 'שמי'],
  age: ['גיל'],
  height: ['גובה'],
  city: ['מגורים', 'מקום מגורים', 'אזור מגורים', 'א. מגורים', 'א מגורים', 'מגורים בהווה', 'מגורים בהווה ומגורי המשפחה'],
  edah: ['עדה', 'מוצא'],
  sector: ['רמה דתית', 'מגזר', 'מגזר+רמה דתית', 'מגזר ורמה דתית', 'רמה דתית ומגזר'],
  status: ['סטטוס', 'רווק/גרוש/אלמן', 'מצב משפחתי'],
  occupation: ['עיסוק', 'עיסוק+מוסדות לימודים', 'עיסוק+ מוסדות לימוד', 'עיסוק ומוסדות לימוד'],
  about: ['תכונות אופי', 'תכונות מאופי', 'תכונות', 'קצת עלי', 'קצת עליי', 'על עצמי'],
  family: ['משפחה', 'קצת על משפחתך', 'תאר/י בקווים כלליים את משפחתך', 'תאר בקווים כלליים את משפחתך', 'תארי בקווים כלליים את משפחתך'],
  service: ['שירות צבאי', 'שירות לאומי', 'שירות צבאי/לאומי', 'שירות צבאי/לאומי/ישיבה'],
  yeshiva: ['ישיבה', 'ישיבה/ מדרשה', 'ישיבה/מדרשה', 'מדרשה'],
  seeking: ['אני מחפש', 'אני מחפשת', 'אני מחפש/ת', 'מה אני מחפש/ת', 'מה אני מחפש', 'מה אני מחפשת', 'מה מחפש', 'מה מחפשת', 'מחפש/ת', 'מחפש', 'מחפשת'],
  ageRange: ['טווח גילאים', 'טווח גילים', 'טווח הגילאים'],
  photos: ['תמונות', 'תמונה'],
  phone: ['טלפון', 'לפניות', 'לפרטים', 'השדכן', 'השדכנית'],
  selfIntro: [], // generated from free-text sentences
};

// ── Emoji + decoration stripper ──────────────────────────
// Remove WhatsApp decorations from the start of a label/value.
// Covers emojis (most BMP + surrogate pairs), zero-width joiners,
// variation selectors, and bullet-like punctuation.

const EMOJI_RE = /[\u2190-\u2BFF\u2300-\u27BF\uFE0F\u200D\p{Extended_Pictographic}]+/gu;
const DECORATION_RE = /^[\s\-*•·★✦➤›»→💘🌷😊👤👳👪🎓🎂🌱🏡🙏📖🌡🎭🎯📸🎚☎⭐️💐🥂✨🇮🇱]+/u;

export function stripDecorations(s: string): string {
  return s
    .replace(EMOJI_RE, ' ')
    .replace(DECORATION_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Label resolver ───────────────────────────────────────
// Given a raw "prefix: value" line, return the canonical field
// key and the value portion (trimmed). Returns null if no label
// matches or if the line has no colon separator.

export interface LabelHit {
  field: FieldKey;
  value: string;
  rawLabel: string;
}

// Accept both `:` and the fullwidth colon, optional whitespace around.
const COLON_RE = /\s*[:：]\s*/;

export function resolveLabel(rawLine: string): LabelHit | null {
  const line = stripDecorations(rawLine);
  if (!line) return null;
  const colonIdx = line.search(COLON_RE);
  if (colonIdx <= 0) return null;

  const labelPart = line.slice(0, colonIdx).trim();
  const valuePart = line.slice(colonIdx).replace(COLON_RE, '').trim();
  if (!labelPart) return null;

  const labelNorm = normalizeLabel(labelPart);

  for (const [field, variants] of Object.entries(LABEL_SYNONYMS) as [FieldKey, string[]][]) {
    for (const variant of variants) {
      if (labelMatches(labelNorm, normalizeLabel(variant))) {
        return { field, value: valuePart, rawLabel: labelPart };
      }
    }
  }
  return null;
}

function normalizeLabel(s: string): string {
  return s
    .replace(/[()]/g, '')
    .replace(/[״"׳']/g, '')
    .replace(/[\s]+/g, ' ')
    .trim();
}

function labelMatches(candidate: string, target: string): boolean {
  if (candidate === target) return true;
  // allow target to be a prefix of candidate ("אני מחפש" matches "אני מחפש/ת")
  if (candidate.startsWith(target)) return true;
  if (target.startsWith(candidate)) return true;
  return false;
}

// ── Value parsers ────────────────────────────────────────

export function parseAge(raw: string): { age?: number; ageText?: string } {
  const m = raw.match(/(\d{1,2}(?:\.\d+)?)/);
  if (!m) return { ageText: raw };
  const n = Number(m[1]);
  if (Number.isNaN(n) || n < 15 || n > 99) return { ageText: raw };
  return { age: Math.round(n), ageText: raw };
}

/** Height: accepts "1.65", "1.65 מ'", "172", "172 ס\"מ". Always returns cm. */
export function parseHeight(raw: string): number | undefined {
  const cleaned = raw.replace(/[^\d.,]/g, ' ').trim();
  // e.g. "1.65"
  const mFloat = cleaned.match(/^\s*(1\.\d{2})/);
  if (mFloat) return Math.round(Number(mFloat[1]) * 100);
  // e.g. "165" or "172"
  const mInt = cleaned.match(/(\d{3})/);
  if (mInt) {
    const n = Number(mInt[1]);
    if (n >= 130 && n <= 220) return n;
  }
  // e.g. "1 65" (split by space due to apostrophe)
  const mSplit = cleaned.match(/^(1)[ .](\d{2})/);
  if (mSplit) {
    const n = Number(`1.${mSplit[2]}`);
    if (n >= 1.3 && n <= 2.2) return Math.round(n * 100);
  }
  return undefined;
}

export function parsePersonalStatus(raw: string): PersonalStatus | undefined {
  const s = raw.trim();
  // Hebrew letters have separate final forms (ן/נ, ם/מ, ץ/צ, ף/פ, ך/כ) —
  // match both so "אלמן" (final nun) and "אלמנה" (medial) both hit.
  if (/אלמ[ןנ]/.test(s)) return PersonalStatus.WIDOWED;
  if (/גרוש/.test(s)) return PersonalStatus.DIVORCED;
  if (/פרוד/.test(s)) return PersonalStatus.SEPARATED;
  if (/רווק/.test(s)) return PersonalStatus.SINGLE;
  return undefined;
}

/** Best-effort sectorGroup classification from free Hebrew text.
 *
 * Order matters: compound terms (dati_leumi, hardal) checked before base
 * terms. DATI is checked BEFORE HAREDI so that "דתיה (באה מבית חרדי)" —
 * a dati-from-haredi-upbringing profile — classifies by the self-label,
 * not by the parenthesized background note. */
export function parseSectorGroup(raw: string): SectorGroup | undefined {
  // Constrain to the head of the value — the primary self-label — so
  // parenthetical notes further along don't hijack classification.
  const s = raw.slice(0, 40);
  if (/חרדל|חרד"ל/.test(s)) return SectorGroup.HARDAL;
  if (/תורני/.test(s)) return SectorGroup.TORANI;
  // accept "דתי לאומי", "דתיה לאומית", "דתי-לאומי", "דת״ל"
  if (/דתי[-\s]*לאומי|דתיה[-\s]*לאומית|דת["״]ל/.test(s)) return SectorGroup.DATI_LEUMI;
  if (/מסורת/.test(s)) return SectorGroup.MASORTI;
  // "דתי" / "דתיה" / "דתית" — matched before HAREDI so "בית חרדי"
  // background phrases don't outrank the self-label.
  if (/דתי[הת]?/.test(s)) return SectorGroup.DATI;
  if (/חרדי/.test(s)) return SectorGroup.HAREDI;
  return undefined;
}

export function parseAgeRange(raw: string): { min?: number; max?: number } | undefined {
  const nums = raw.match(/\d{1,2}/g);
  if (!nums || nums.length < 2) return undefined;
  const a = Number(nums[0]);
  const b = Number(nums[1]);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  if (min < 15 || max > 99) return undefined;
  return { min, max };
}

/** Extract Israeli phone numbers, normalized to digits. Dedup, keep order. */
export function parsePhones(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:\+?972[-\s]?|0)(5\d)[-\s]?(\d{3})[-\s]?(\d{4})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const normalized = `0${m[1]}${m[2]}${m[3]}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

/** Split raw name into first + last. Handles "הדס .ו" (initial) and single names. */
export function parseName(raw: string): { firstName?: string; lastName?: string } {
  const cleaned = raw
    .replace(/[״"׳']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return {};
  // Split on whitespace. Keep initial (like ".ו") as lastName.
  const parts = cleaned.split(' ').filter((p) => p.length > 0);
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// ── Gender inference ─────────────────────────────────────
// Combine signals. Each signal has weight; final gender is whichever
// side has majority. Return undefined on tie.

export interface GenderSignals {
  maleWeight: number;
  femaleWeight: number;
  gender?: Gender;
}

export function inferGender(text: string, _status?: PersonalStatus): GenderSignals {
  let male = 0;
  let female = 0;

  // 1) Status tokens — strongest self-identifier.
  if (/רווקה|גרושה|אלמנה|פרודה/.test(text)) female += 3;
  if (/(^|\s)רווק(\s|$|\.|,)|(^|\s)גרוש(\s|$|\.|,)|אלמ[ןנ](\s|$|\.|,|ה\W)/.test(text)) male += 3;

  // 2) Seeking direction — target noun tells us SELF is the opposite.
  //    Allow up to 40 chars between "מחפש" and the target noun (handles
  //    "אני מחפש/ת :  בחורה טובה" where slash+colon sit in between).
  if (/מחפש[^\n]{0,40}בחורה/.test(text)) male += 3;
  if (/מחפש[^\n]{0,40}(^|[^\wא-ת])בחור([^\wא-ת]|$)/.test(text)) female += 3;

  // 3) Possessive phrases about target.
  if (/שיהיה\s+לה|שהיה\s+לה|שתהיה|\bשהיא\b/.test(text)) male += 2;
  if (/שיהיה\s+לו|שהיה\s+לו|שיהא\s+לו|\bשהוא\b/.test(text)) female += 2;

  // 4) Self-intro verb conjugations. Weight 1 — noisy on their own.
  if (/(^|\s)אוהבת|(^|\s)לומדת|(^|\s)עובדת|(^|\s)חייכנית|(^|\s)זורמת|(^|\s)סטודנטית/.test(text)) female += 1;
  if (/(^|\s)אוהב(\s|$|\.|,)|(^|\s)לומד(\s|$|\.|,)|(^|\s)עובד(\s|$|\.|,)|(^|\s)סטודנט(\s|$|\.|,)/.test(text)) male += 1;

  if (female === 0 && male === 0) return { maleWeight: 0, femaleWeight: 0 };
  if (female > male) return { maleWeight: male, femaleWeight: female, gender: Gender.FEMALE };
  if (male > female) return { maleWeight: male, femaleWeight: female, gender: Gender.MALE };
  return { maleWeight: male, femaleWeight: female };
}
