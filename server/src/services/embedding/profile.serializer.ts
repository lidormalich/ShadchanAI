// ═══════════════════════════════════════════════════════════
// ShadchanAI — Profile Serializer
//
// Converts a candidate document into 4 Hebrew text chunks,
// one per semantic domain.  These texts are sent to the
// embedding model to produce the vectors stored in the DB.
//
// Design principles:
//   • Pure functions — no side effects, no DB calls.
//   • Defensive — missing/null fields are silently omitted.
//     The output never contains the word "undefined".
//   • Hebrew-first — enum values are translated to natural
//     Hebrew so the multilingual bge-m3 model can leverage
//     its Hebrew training rather than treating them as opaque
//     English tokens.
//   • Chunk independence — each chunk function only reads
//     the fields relevant to its semantic domain. This makes
//     invalidation (regenerate only the stale chunk) safe.
// ═══════════════════════════════════════════════════════════

import type {
  SectorGroup,
  SubSector,
  LifestyleTone,
  ReligiousStyle,
  PersonalStatus,
  LifeStage,
  StudyWorkDirection,
} from '@shadchanai/shared';
import type { IInternalCandidate } from '../../modules/candidates/internal-candidate.model.js';
import type { IExternalCandidate } from '../../modules/candidates/external-candidate.model.js';
import type { ChunkTexts } from './embedding.types.js';

// ── Hebrew lookup tables ──────────────────────────────────
//
// Why translate to Hebrew rather than keeping English enum values?
//
// bge-m3 is a multilingual model fine-tuned on Hebrew data.
// When the text says "דתי לאומי" the model can relate it to
// real Hebrew training examples; when it says "dati_leumi" it
// treats it as an opaque English slug with no semantic context.
// Translating to Hebrew significantly improves retrieval quality
// for the religious-identity chunk in particular.

const SECTOR_GROUP_HE: Record<SectorGroup, string> = {
  dati_leumi: 'דתי לאומי',
  haredi:     'חרדי',
  dati:       'דתי',
  masorti:    'מסורתי',
  hardal:     'חרד"ל',
  torani:     'תורני',
  other:      'אחר',
};

const SUB_SECTOR_HE: Record<SubSector, string> = {
  dati_leumi_open:    'דתי לאומי פתוח',
  dati_leumi_classic: 'דתי לאומי קלאסי',
  dati_leumi_torani:  'דתי לאומי תורני',
  haredi_litvish:     'חרדי ליטאי',
  haredi_hasidic:     'חרדי חסידי',
  haredi_sephardi:    'חרדי ספרדי',
  haredi_modern:      'חרדי מודרני',
  dati_lite:          'דתי קל',
  dati_classic:       'דתי קלאסי',
  hardal_classic:     'חרד"ל קלאסי',
  hardal_open:        'חרד"ל פתוח',
  other:              'אחר',
};

const LIFESTYLE_TONE_HE: Record<LifestyleTone, string> = {
  very_strict: 'מחמיר מאוד',
  strict:      'מחמיר',
  moderate:    'ממוצע',
  relaxed:     'מקל',
  flexible:    'גמיש',
};

const RELIGIOUS_STYLE_HE: Record<ReligiousStyle, string> = {
  halachic_strict:       'הלכתי מחמיר',
  halachic_mainstream:   'הלכתי מרכזי',
  traditional_observant: 'מסורתי שומר',
  spiritual_flexible:    'רוחני גמיש',
  cultural:              'תרבותי-דתי',
};

const PERSONAL_STATUS_HE: Record<PersonalStatus, string> = {
  single:    'רווק/ה',
  divorced:  'גרוש/ה',
  widowed:   'אלמן/ה',
  separated: 'פרוד/ה',
};

const LIFE_STAGE_HE: Record<LifeStage, string> = {
  post_high_school:  'לאחר תיכון',
  national_service:  'שירות לאומי',
  army:              'בצבא',
  yeshiva_seminary:  'ישיבה / מדרשה',
  early_studies:     'תחילת לימודים',
  mid_studies:       'אמצע לימודים',
  early_career:      'תחילת קריירה',
  established_career:'קריירה מבוססת',
  mature:            'בשל/ה',
};

const STUDY_WORK_HE: Record<StudyWorkDirection, string> = {
  full_time_torah:     'לומד/ת תורה במשרה מלאה',
  torah_with_work:     'תורה ועבודה',
  academic_studies:    'לימודים אקדמיים',
  professional_training:'הכשרה מקצועית',
  working:             'עובד/ת',
  military_career:     'קריירה צבאית',
  entrepreneurial:     'יזמות',
  hesder:              'הסדר',
  mechina_army:        'מכינה וצבא',
  sherut_leumi:        'שירות לאומי',
  undecided:           'עדיין לא החליט/ה',
};

const AGE_FLEXIBILITY_HE: Record<string, string> = {
  strict:            'קפדן/ית',
  somewhat_flexible: 'גמיש/ה במקצת',
  very_flexible:     'גמיש/ה מאוד',
};

const IMPORTANCE_HE: Record<string, string> = {
  must_have:   'חובה',
  important:   'חשוב',
  nice_to_have:'רצוי',
  flexible:    'גמיש',
};

// Human-readable Hebrew labels for known preference field names.
// Unknown fields fall back to the raw field name — still useful for
// the model even without a perfect translation.
const PREF_FIELD_LABEL_HE: Record<string, string> = {
  city:               'עיר',
  sectorGroup:        'מגזר',
  subSector:          'תת-מגזר',
  lifestyleTone:      'סגנון חיים',
  religiousStyle:     'סגנון דתי',
  studyWorkDirection: 'כיוון לימודים/עבודה',
  personalStatus:     'מצב אישי',
  age:                'גיל',
  height:             'גובה',
  location:           'מיקום',
  educationLevel:     'השכלה',
  armyService:        'שירות צבאי',
  numberOfChildren:   'מספר ילדים',
};

// ── Low-level helpers ─────────────────────────────────────

/** Appends "label: value. " only when value is non-empty. */
function field(label: string, value: string | number | undefined | null): string {
  if (value === null || value === undefined || value === '') return '';
  return `${label}: ${value}. `;
}

/** Computes age in whole years from a Date of birth. */
function ageFromDob(dob: Date): number {
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

/**
 * Serialises a soft-preferences array into a single readable sentence.
 *
 * Why include preferences in the embedding?  Because two candidates
 * with identical demographics but opposite stated preferences ("מחפש/ת
 * מישהו שלומד כל היום" vs "מחפש/ת מישהו שעובד") should land far apart
 * in vector space even though their background chunk would be similar.
 */
function serializeSoftPreferences(
  prefs: Array<{ field: string; value: unknown; importance: string; note?: string }> | undefined,
): string {
  if (!prefs?.length) return '';

  const parts = prefs.map(p => {
    const label     = PREF_FIELD_LABEL_HE[p.field] ?? p.field;
    const value     = String(p.value);
    const importance = IMPORTANCE_HE[p.importance] ?? p.importance;
    const note      = p.note ? ` (${p.note})` : '';
    return `${label}=${value} [${importance}]${note}`;
  });

  return `העדפות: ${parts.join(', ')}. `;
}

/**
 * Serialises an openness-flags object into a short Hebrew sentence.
 *
 * We output only the flags that are TRUE — false flags add noise
 * without semantic signal since the default is "not open".
 */
function serializeOpenness(
  openness: Partial<{
    openToOtherSectors: boolean;
    openToConverts: boolean;
    openToDivorced: boolean;
    openToWithChildren: boolean;
    openToAgeDifference: boolean;
    openToLongDistance: boolean;
  }> | undefined,
): string {
  if (!openness) return '';

  const trueFlags: string[] = [];
  if (openness.openToOtherSectors) trueFlags.push('מגזרים אחרים');
  if (openness.openToConverts)     trueFlags.push('גיורים');
  if (openness.openToDivorced)     trueFlags.push('גרושים');
  if (openness.openToWithChildren) trueFlags.push('בעלי ילדים');
  if (openness.openToAgeDifference)trueFlags.push('פער גילים');
  if (openness.openToLongDistance) trueFlags.push('מרחק גיאוגרפי');

  if (!trueFlags.length) return '';
  return `פתוח/ה ל: ${trueFlags.join(', ')}. `;
}

// ── Chunk 1: Religious & Lifestyle ───────────────────────
//
// What's included: sector, sub-sector, lifestyle tone, religious style.
//
// Why this chunk carries the highest weight (0.40):
//   In the Israeli religious dating market, sector alignment is the
//   single strongest predictor of match success.  A Haredi candidate
//   and a Dati-Leumi candidate have fundamentally different life
//   structures regardless of how similar their personalities are.

function buildReligiousChunk(
  sectorGroup: SectorGroup | undefined,
  subSector: SubSector | undefined,
  lifestyleTone: LifestyleTone | undefined,
  religiousStyle: ReligiousStyle | undefined,
): string | null {
  const parts = [
    field('זהות דתית', sectorGroup ? SECTOR_GROUP_HE[sectorGroup] : undefined),
    field('תת-קבוצה', subSector ? SUB_SECTOR_HE[subSector] : undefined),
    field('עמדה הלכתית', lifestyleTone ? LIFESTYLE_TONE_HE[lifestyleTone] : undefined),
    field('סגנון דתי', religiousStyle ? RELIGIOUS_STYLE_HE[religiousStyle] : undefined),
  ].join('');

  // A chunk with no content is not worth embedding — return null so
  // the embedding service skips this sub-pipeline.
  return parts.trim() || null;
}

// ── Chunk 2: Expectations ─────────────────────────────────
//
// What's included: what they're looking for in a partner,
// stated preferences (soft), and openness flags.
//
// Why separate from personality:
//   A candidate's self-description ("אני אוהב ספורט") and their
//   partner expectations ("מחפש/ת מישהו שלומד") are semantically
//   orthogonal.  Mixing them would dilute both signals.

function buildExpectationsChunk(
  whatSeeking: string | undefined,
  softPreferences: Array<{ field: string; value: unknown; importance: string; note?: string }> | undefined,
  openness: Partial<{
    openToOtherSectors: boolean; openToConverts: boolean; openToDivorced: boolean;
    openToWithChildren: boolean; openToAgeDifference: boolean; openToLongDistance: boolean;
  }> | undefined,
  agePreferences: { min?: number; max?: number; flexibility?: string } | undefined,
): string | null {
  const parts = [
    whatSeeking ? `מחפש/ת: ${whatSeeking.trim()}. ` : '',
    agePreferences?.min != null || agePreferences?.max != null
      ? field(
          'גיל מועדף',
          [
            agePreferences.min != null ? `מ-${agePreferences.min}` : '',
            agePreferences.max != null ? `עד ${agePreferences.max}` : '',
            agePreferences.flexibility
              ? `(${AGE_FLEXIBILITY_HE[agePreferences.flexibility] ?? agePreferences.flexibility})`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
        )
      : '',
    serializeOpenness(openness),
    serializeSoftPreferences(softPreferences),
  ].join('');

  return parts.trim() || null;
}

// ── Chunk 3: Personality ──────────────────────────────────
//
// What's included: free-text self-description, AI-enriched
// personality traits, and stated values.
//
// Why we include aiEnrichment:
//   Many profiles have sparse "about" text but rich AI-extracted
//   traits.  Including both maximises the semantic signal without
//   double-counting (traits are usually more structured than about).

function buildPersonalityChunk(
  about: string | undefined,
  aiEnrichment: {
    personalityTraits?: string[];
    values?: string[];
    summary?: string;
  } | undefined,
): string | null {
  const parts = [
    about?.trim() ? `על עצמי: ${about.trim()}. ` : '',
    aiEnrichment?.personalityTraits?.length
      ? `תכונות אישיות: ${aiEnrichment.personalityTraits.join(', ')}. `
      : '',
    aiEnrichment?.values?.length
      ? `ערכים: ${aiEnrichment.values.join(', ')}. `
      : '',
    // Only fall back to the AI summary if there is nothing else —
    // it tends to be more generic and we don't want it drowning out
    // specific user-provided text.
    !about?.trim() && !aiEnrichment?.personalityTraits?.length && aiEnrichment?.summary?.trim()
      ? `תיאור: ${aiEnrichment.summary.trim()}. `
      : '',
  ].join('');

  return parts.trim() || null;
}

// ── Chunk 4: Background ───────────────────────────────────
//
// What's included: age, city, personal status, life stage,
// study/work direction.
//
// Why this chunk carries the lowest weight (0.10):
//   Age and location are already enforced by the Atlas pre-filter
//   as hard constraints.  Life-stage and study direction have some
//   semantic value but are coarser signals than religious identity.

function buildBackgroundChunk(
  age: number | undefined,
  city: string | undefined,
  personalStatus: PersonalStatus | undefined,
  numberOfChildren: number | undefined,
  lifeStage: LifeStage | undefined,
  studyWorkDirection: StudyWorkDirection | undefined,
): string | null {
  const childrenText =
    numberOfChildren != null && numberOfChildren > 0
      ? field('ילדים', `${numberOfChildren}`)
      : '';

  const parts = [
    field('גיל', age),
    field('עיר', city),
    field('מצב אישי', personalStatus ? PERSONAL_STATUS_HE[personalStatus] : undefined),
    childrenText,
    field('שלב חיים', lifeStage ? LIFE_STAGE_HE[lifeStage] : undefined),
    field('כיוון לימודים/עבודה', studyWorkDirection ? STUDY_WORK_HE[studyWorkDirection] : undefined),
  ].join('');

  return parts.trim() || null;
}

// ── Public API ────────────────────────────────────────────

/**
 * Serialises an InternalCandidate document into 4 chunk texts.
 *
 * InternalCandidate stores date-of-birth (not age directly), so we
 * compute the current age here.  All other fields mirror External.
 */
export function serializeInternalChunks(doc: IInternalCandidate): ChunkTexts {
  const age = doc.dateOfBirth ? ageFromDob(new Date(doc.dateOfBirth)) : undefined;

  return {
    religious: buildReligiousChunk(
      doc.sectorGroup,
      doc.subSector,
      doc.lifestyleTone,
      doc.religiousStyle,
    ),
    expectations: buildExpectationsChunk(
      doc.whatSeeking,
      doc.softPreferences,
      doc.openness,
      doc.agePreferences,
    ),
    personality: buildPersonalityChunk(
      doc.about,
      doc.aiEnrichment,
    ),
    background: buildBackgroundChunk(
      age,
      doc.city,
      doc.personalStatus,
      doc.numberOfChildren,
      doc.lifeStage,
      doc.studyWorkDirection,
    ),
  };
}

/**
 * Serialises an ExternalCandidate document into 4 chunk texts.
 *
 * External profiles are often partial (extracted from WhatsApp) so
 * more chunks are likely to return null.  That is expected and safe —
 * the similarity service omits missing sub-pipelines from $rankFusion
 * and re-normalises the remaining weights.
 */
export function serializeExternalChunks(doc: IExternalCandidate): ChunkTexts {
  return {
    religious: buildReligiousChunk(
      doc.sectorGroup,
      doc.subSector,
      doc.lifestyleTone,
      undefined, // external model has no religiousStyle field
    ),
    expectations: buildExpectationsChunk(
      doc.whatSeeking,
      doc.softPreferences,
      doc.openness,
      doc.agePreferences,
    ),
    personality: buildPersonalityChunk(
      doc.about,
      doc.aiEnrichment,
    ),
    background: buildBackgroundChunk(
      doc.age,
      doc.city,
      doc.personalStatus,
      undefined, // external model has no numberOfChildren field
      doc.lifeStage,
      doc.studyWorkDirection,
    ),
  };
}

/**
 * Returns the chunk text for a single chunk type.
 * Used by the embedding service when regenerating a specific stale chunk.
 */
export function serializeSingleChunk(
  doc: IInternalCandidate | IExternalCandidate,
  chunkType: 'religious' | 'expectations' | 'personality' | 'background',
  candidateType: 'internal' | 'external',
): string | null {
  const chunks =
    candidateType === 'internal'
      ? serializeInternalChunks(doc as IInternalCandidate)
      : serializeExternalChunks(doc as IExternalCandidate);
  return chunks[chunkType];
}
