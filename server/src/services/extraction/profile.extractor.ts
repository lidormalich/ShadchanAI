// ═══════════════════════════════════════════════════════════
// ShadchanAI — Unified Profile Extractor (AI)
//
// ONE smart service behind the "הדבק כרטיס → מלא ב-AI" affordance on
// BOTH the internal and external candidate intake forms. Given a
// free-text shidduch card (WhatsApp / paper, label-based OR free
// prose), it returns a generic SUPERSET of every field a card can
// carry. Each form then maps the superset to its own shape:
//   - internal: age → estimated dateOfBirth; candidatePhone → phone;
//     contactName/contactPhone → reference; rich free fields kept.
//   - external: age kept as-is; contact → contactPhone; fields with no
//     external home (occupation/family/…) folded into `about`.
//
// This replaces the former internal.extractor + external.extractor:
// one prompt to improve, both forms benefit.
//
// Distinct from `ai.extractor.ts` (extractProfileWithAI) — that is the
// WhatsApp-ingestion path with isProfile gating; it must NOT change.
// Here the operator deliberately pasted a card, so we always extract.
//
// Design: every field OPTIONAL. A missing value means "ask the human";
// a fabricated value is far worse. confidence ∈ [0,1] is the model's
// self-report. warnings (Hebrew) flags anything to double-check.
// ═══════════════════════════════════════════════════════════

import { z } from 'zod';
import {
  AIRequestType,
  Gender,
  SectorGroup,
  SubSector,
  LifestyleTone,
  ReligiousStyle,
  PersonalStatus,
  LifeStage,
  ReadinessForMarriage,
  StudyWorkDirection,
} from '@shadchanai/shared';
import { executeWithFallback } from '../ai/ai.service.js';
import type { ChatMessage } from '../ai/ai.types.js';

// ── Unified output schema (superset) ─────────────────────

// Tolerant field builders: a junk value (empty string, out-of-range
// number, hallucinated enum) collapses to undefined instead of sinking
// the WHOLE extraction. LLMs occasionally emit "" or 0 for fields they
// "couldn't fill" — we treat those as absent, not as a hard failure.
const str = (max: number) => z.string().trim().min(1).max(max).optional().catch(undefined);
const int = (min: number, max: number) =>
  z.number().int().min(min).max(max).optional().catch(undefined);
const flag = z.boolean().optional().catch(undefined);
// Wrap any enum schema so an out-of-vocabulary value → undefined.
const opt = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);

export const ProfileExtractionSchema = z.object({
  confidence: z.number().min(0).max(1).catch(0.5),
  warnings: z.array(z.string().trim().min(1).max(300)).max(12).default([]).catch([]),

  // Identity
  firstName: str(100),
  lastName: str(100),
  hebrewName: str(100),
  gender: opt(z.enum([Gender.MALE, Gender.FEMALE])),
  age: int(15, 99),
  // Only when an explicit full birth date appears (ISO yyyy-mm-dd).
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  height: int(100, 220),
  city: str(100),
  neighborhood: str(100),
  ethnicity: str(100), // עדה / מוצא

  // Contact: keep the candidate's own number separate from the
  // "person to contact about this card" (often the referrer).
  candidatePhone: str(50),
  contactName: str(100), // "אשת קשר" / "טלפון לברורים: X"
  contactPhone: str(50), // "מספר לפניות"

  // Religious identity
  sectorGroup: opt(z.enum([
    SectorGroup.DATI_LEUMI,
    SectorGroup.HAREDI,
    SectorGroup.DATI,
    SectorGroup.MASORTI,
    SectorGroup.HARDAL,
    SectorGroup.TORANI,
    SectorGroup.OTHER,
  ])),
  subSector: opt(z.nativeEnum(SubSector)),
  lifestyleTone: opt(z.nativeEnum(LifestyleTone)),
  religiousStyle: opt(z.nativeEnum(ReligiousStyle)),
  religiousLevelText: str(300), // free "השקפה" text

  // Status & stage
  personalStatus: opt(z.enum([
    PersonalStatus.SINGLE,
    PersonalStatus.DIVORCED,
    PersonalStatus.WIDOWED,
    PersonalStatus.SEPARATED,
  ])),
  numberOfChildren: int(0, 20),
  lifeStage: opt(z.nativeEnum(LifeStage)),
  readinessForMarriage: opt(z.nativeEnum(ReadinessForMarriage)),

  // Study / work
  studyWorkDirection: opt(z.nativeEnum(StudyWorkDirection)),
  currentOccupation: str(300),
  educationLevel: str(200),
  educationInstitution: str(200), // ישיבה/סמינר/אונ'
  armyService: str(200),

  // Misc card fields with no dedicated DB column (→ additionalInfo on save)
  headCovering: str(120), // כיסוי ראש
  smoking: str(60),        // מעשן: לא / לפעמים / כן

  // Free text
  about: str(2000),
  whatSeeking: str(2000),
  familyBackground: str(1000), // "תאר/י את משפחתך"

  // Partner age preference
  seekingAgeMin: int(15, 99),
  seekingAgeMax: int(15, 99),

  // Openness flags (only when explicit)
  openToOtherSectors: flag,
  openToConverts: flag,
  openToDivorced: flag,
  openToWithChildren: flag,
  openToAgeDifference: flag,
  openToLongDistance: flag,
});

export type ProfileExtraction = z.infer<typeof ProfileExtractionSchema>;

// ── Prompt builder ───────────────────────────────────────

function buildPrompt(cardText: string, strictRetry: boolean): ChatMessage[] {
  const strictSuffix = strictRetry
    ? '\n\nCRITICAL: Your previous response was not valid JSON. Output ONLY a single JSON object, no prose, no markdown fences.'
    : '';

  const system = `You are a profile-extraction engine for a Hebrew religious matchmaking (shidduch) system.

TASK: Given a free-text candidate card, extract structured fields about the ONE person the card describes.

RULES:
- Output a SINGLE JSON object, no markdown, no commentary.
- EXTRACT EVERY FACT THE CARD STATES. If a value is written explicitly — especially after a label like "שם:", "גיל:", "גובה:", "מגורים:", "עדה:", "השקפה:" — you MUST fill that field. Do not leave a clearly-stated field empty.
- Cards come in TWO styles, handle BOTH:
  (a) Label-based, often emoji-prefixed: "🎂 גיל: 27", "🌱 גובה: 1.74", "🏡 מגורים: ירושלים". Ignore the emoji; read the value after the label.
  (b) Free prose with no labels: e.g. "בת 24, 1.60, דתיה לאומית, סיימה שירות לאומי, מחפשת בחור...". Infer fields from the sentence (age 24, height 160, gender female, sector dati_leumi, lifeStage/education, whatSeeking).
- "Be conservative / omit" applies ONLY to values genuinely absent or ambiguous — NOT to facts plainly written.
- The card describes the CANDIDATE. What they SEEK goes in whatSeeking / seekingAgeMin / seekingAgeMax — never in the candidate's own fields.
- NEVER drop content. Map every stated detail to the closest field; truly unmappable remarks still belong somewhere (familyBackground / about).
- "confidence" ∈ [0,1] is your self-reported confidence. "warnings" is a short Hebrew list of things the human should verify (ambiguous sector, estimated age, conflicting data…).

HEBREW MAPPING NOTES:
- Name: text after "שם:" (or a name at the very top) is the full name. FIRST token → firstName, REST → lastName. e.g. "שם: יאיר בצלאל" → firstName="יאיר", lastName="בצלאל". A lone first name → firstName only.
- gender: who the card is ABOUT, by the words (emojis are decorative/unreliable). "בחור"/"רווק"/"בן 22"/masculine verbs + "מחפש אשה/בחורה" → male. "בחורה"/"רווקה"/"בת 24"/feminine + "מחפשת בחור" → female.
- age: integer years. A value like "1.74"/"1.60" is HEIGHT, never age.
- height: integer centimeters. "1.74"→174 ; "1.60"→160 ; "174"→174 ; "178 ס״מ"→178.
- city: "מגורים:"/"גר/ה ב"/"עיר:" → city (e.g. "ירושלים", "שדרות", "בית שמש").
- ethnicity: "עדה:" / origin → e.g. "מרוקאית", "חצי בוכרי חצי צבר", "ספרדיה".
- candidatePhone: a phone clearly belonging to the candidate. contactName + contactPhone: the person/number to contact ABOUT the card — "טלפון ליצירת קשר", "מספר לפניות", "אשת קשר", "טלפון לברורים: <name>". Put a name there in contactName, a number in contactPhone.
- sectorGroup: "דתי לאומי" → dati_leumi ; "חרדי/ת"/"חרדית" → haredi ; "דתי/ה"/"דתייה" (without לאומי) → dati ; "חרדל" → hardal ; "תורני/ת" → torani ; "מסורתי/ת" → masorti. Otherwise omit.
- religiousLevelText: copy the raw "השקפה" wording, e.g. "חרדית, מתחבר מאוד לחסידות ולברסלב".
- subSector (only if clear): dati_leumi_open/classic/torani, haredi_litvish/hasidic/sephardi/modern, dati_lite/classic, hardal_classic/open, other.
- lifestyleTone (optional): very_strict, strict, moderate, relaxed, flexible.
- religiousStyle (optional): halachic_strict, halachic_mainstream, traditional_observant, spiritual_flexible, cultural.
- personalStatus: "רווק/ה" → single ; "גרוש/ה" → divorced ; "אלמן/אלמנה" → widowed ; "פרוד/ה" → separated. ("מצב משפחתי:" introduces this.)
- numberOfChildren: integer. "ילדים: אין" → 0.
- lifeStage (optional): post_high_school, national_service, army, yeshiva_seminary, early_studies, mid_studies, early_career, established_career, mature.
- readinessForMarriage (optional): actively_looking, open, exploring, not_ready, on_hold.
- studyWorkDirection (optional): full_time_torah (אברך/כולל/"עיסוק: ישיבה"), torah_with_work, academic_studies (סטודנט/תואר/אקדמיה), professional_training, working (עובד/ת), military_career (קבע), entrepreneurial, hesder, mechina_army, sherut_leumi (שירות לאומי), undecided.
- currentOccupation: their job/study in their words ("מעצבת אופנה", "סטודנט להנדסה", "תחומי היופי"). "עיסוק:" introduces this.
- educationLevel: "השכלה:" value ("תואר בהנדסה", "תיכונית ומקצועית", "תעודת בגרות"). educationInstitution: "ישיבה/סמינר:"/college name ("משכן דוד", "אונ' אריאל").
- armyService: "שירות צבאי/לאומי/ישיבה:" value ("צבא", "שירות לאומי", "ישיבה").
- headCovering: "כיסוי ראש:" value ("פאה ומטפחת", "לא", "בר דיון"). smoking: "מעשן/ת:" value ("לא", "לפעמים", "כן").
- about: concise Hebrew summary of who the candidate IS — the "קצת עלי" text + personality/values. whatSeeking: what they want in a partner ("אני מחפש/ת ...").
- familyBackground: the "תאר/י את משפחתך" text ("משפחה חמה ואוהבת + שני אחים").
- seekingAgeMin/seekingAgeMax: "טווח גילאים מבוקש: מ-20 עד 28" → min 20, max 28.
- openness flags: true ONLY when explicit (e.g. "פתוח/ה למגזרים אחרים"). Otherwise omit.${strictSuffix}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: cardText },
  ];
}

// ── Public API ───────────────────────────────────────────

export async function extractProfileFromText(
  cardText: string,
  opts: { userId?: string; relatedEntityType?: string } = {},
): Promise<{
  profile: ProfileExtraction;
  providerUsed: string;
  fallbackUsed: boolean;
  latencyMs: number;
}> {
  const result = await executeWithFallback({
    requestType: AIRequestType.CLASSIFY,
    buildPrompt: (strict) => buildPrompt(cardText, strict),
    schema: ProfileExtractionSchema,
    userId: opts.userId,
    relatedEntityType: opts.relatedEntityType ?? 'internal_candidate',
  });

  return {
    profile: result.data,
    providerUsed: result.metadata.provider,
    fallbackUsed: result.metadata.fallbackUsed,
    latencyMs: result.metadata.latencyMs,
  };
}
