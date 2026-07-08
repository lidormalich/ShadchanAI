// ═══════════════════════════════════════════════════════════
// Card-label service — CRUD for operator-taught label→field
// mappings, plus the sync that pushes them into the parser.
//
// The parser (templates.ts) holds a mutable synonym overlay set via
// setCustomLabelSynonyms. This service is the single writer of that
// overlay: it (re)loads every CardLabel row and pushes the merged
// dictionary on boot and after each add/remove — so newly taught
// labels take effect immediately for the next extraction.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { z } from 'zod';
import { AIRequestType } from '@shadchanai/shared';
import { CardLabel, type ICardLabel } from './card-label.model.js';
import {
  setCustomLabelSynonyms,
  normalizeLabel,
  FIELD_KEYS,
  type FieldKey,
} from '../../services/extraction/templates.js';
import { extractProfileFromText } from '../../services/extraction/regex.extractor.js';
import { executeWithFallback } from '../../services/ai/ai.service.js';
import type { ChatMessage } from '../../services/ai/ai.types.js';
import { ConflictError, NotFoundError, ValidationError, isDuplicateKeyError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('card-labels');

export async function listCardLabels(): Promise<ICardLabel[]> {
  return CardLabel.find({}).sort({ field: 1, label: 1 }).lean().exec() as unknown as ICardLabel[];
}

export async function createCardLabel(labelRaw: string, field: string, userId?: string): Promise<ICardLabel> {
  const label = (labelRaw ?? '').trim();
  if (!label) throw new ValidationError('Label is required');
  if (!FIELD_KEYS.includes(field as FieldKey)) {
    throw new ValidationError(`Unknown field "${field}". Allowed: ${FIELD_KEYS.join(', ')}`);
  }
  if (!normalizeLabel(label)) throw new ValidationError('Label has no matchable characters');

  try {
    const doc = await CardLabel.create({
      label,
      field,
      createdBy: userId ? new Types.ObjectId(userId) : undefined,
    });
    await refreshParserLabels();
    log.info({ label, field }, 'card_label_added');
    return doc;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new ConflictError('This label is already mapped', { code: 'duplicate_label' });
    }
    throw err;
  }
}

export async function deleteCardLabel(id: string): Promise<void> {
  if (!Types.ObjectId.isValid(id)) throw new ValidationError('Invalid id');
  const res = await CardLabel.findByIdAndDelete(id).exec();
  if (!res) throw new NotFoundError('CardLabel', id);
  await refreshParserLabels();
  log.info({ id }, 'card_label_removed');
}

// ── "Learn from a full card" (Feature C+) ────────────────
// Paste a whole card → the parser reports what it already recognizes and which
// labels it doesn't; the AI proposes a field for each unknown one; the operator
// confirms and bulk-saves. Teaching a whole format in one shot.

const LABEL_LINE_RE = /^\s*([^:：?？]{1,40})[:：?？]\s*(.*)$/;

const LabelSuggestionSchema = z.object({
  suggestions: z.array(z.object({ label: z.string(), field: z.string().nullable() })),
});

// Field keys with a short Hebrew gloss, for the AI mapping prompt.
const FIELD_GLOSS: Record<FieldKey, string> = {
  name: 'שם פרטי/מלא', age: 'גיל', height: 'גובה', city: 'עיר/אזור מגורים',
  edah: 'עדה/מוצא', sector: 'רמה דתית/מגזר/השקפה', status: 'מצב משפחתי',
  occupation: 'עיסוק/מקצוע/לימודים', about: 'תיאור אישי/אופי/תחביבים/מראה',
  family: 'רקע משפחתי', service: 'שירות צבאי/לאומי', yeshiva: 'ישיבה/מדרשה/סמינר/השכלה',
  seeking: 'מה מחפש/ציפיות', ageRange: 'טווח גילאים מבוקש', maxAge: 'גיל מקסימלי מבוקש',
  photos: 'תמונות', phone: 'טלפון/יצירת קשר', selfIntro: '',
};

export interface CardAnalysis {
  recognizedFields: FieldKey[];
  unknownLabels: { label: string; value: string; suggestedField: FieldKey | null }[];
}

function buildLabelSuggestPrompt(labels: string[], strict: boolean): ChatMessage[] {
  const options = FIELD_KEYS.filter((k) => k !== 'selfIntro')
    .map((k) => `"${k}" (${FIELD_GLOSS[k]})`).join(', ');
  const system = [
    'אתה ממפה תוויות מכרטיסי שידוכים בעברית לשדות מובנים.',
    `לכל תווית החזר את מפתח השדה המתאים ביותר מהרשימה, או null אם אף אחד לא מתאים: ${options}.`,
    'החזר JSON בלבד בצורה: {"suggestions":[{"label":"<התווית>","field":"<key או null>"}]}.',
    strict ? 'החזר JSON תקין בלבד, ללא טקסט נוסף.' : '',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ labels }) },
  ];
}

export async function analyzeCard(text: string, userId?: string): Promise<CardAnalysis> {
  if (!text || !text.trim()) throw new ValidationError('Card text is required');
  const regex = extractProfileFromText(text);

  // Label-shaped lines the parser couldn't bind, de-duplicated by normalized label.
  const seen = new Set<string>();
  const unknown: { label: string; value: string }[] = [];
  for (const line of regex.unmatchedLines) {
    const m = line.match(LABEL_LINE_RE);
    if (!m) continue;
    const lbl = (m[1] ?? '').trim();
    const key = normalizeLabel(lbl);
    if (!lbl || !key || seen.has(key)) continue;
    seen.add(key);
    unknown.push({ label: lbl, value: (m[2] ?? '').trim() });
  }

  if (unknown.length === 0) return { recognizedFields: regex.matchedFields, unknownLabels: [] };

  // AI suggestion — best-effort. If AI is disabled/unavailable, fall back to
  // null suggestions so the operator can still map manually.
  const suggestionByLabel = new Map<string, string | null>();
  try {
    const res = await executeWithFallback<z.infer<typeof LabelSuggestionSchema>>({
      requestType: AIRequestType.CLASSIFY,
      buildPrompt: (strict) => buildLabelSuggestPrompt(unknown.map((u) => u.label), strict),
      schema: LabelSuggestionSchema,
      userId,
    });
    for (const s of res.data.suggestions) suggestionByLabel.set(normalizeLabel(s.label), s.field);
  } catch (err) {
    log.info({ reason: (err as Error).message }, 'card_analyze_ai_unavailable');
  }

  const unknownLabels = unknown.map((u) => {
    const raw = suggestionByLabel.get(normalizeLabel(u.label));
    const suggestedField = raw && FIELD_KEYS.includes(raw as FieldKey) ? (raw as FieldKey) : null;
    return { label: u.label, value: u.value, suggestedField };
  });

  return { recognizedFields: regex.matchedFields, unknownLabels };
}

/** Save several label→field mappings at once (skips ones already mapped). */
export async function createCardLabelsBulk(
  mappings: Array<{ label: string; field: string }>,
  userId?: string,
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  for (const m of mappings) {
    try {
      await createCardLabel(m.label, m.field, userId);
      created += 1;
    } catch (err) {
      if (err instanceof ConflictError) { skipped += 1; continue; }
      throw err;
    }
  }
  await refreshParserLabels();
  log.info({ created, skipped }, 'card_labels_bulk_added');
  return { created, skipped };
}

/** Load every CardLabel row, group by field, and push the merged overlay into
 *  the parser. Idempotent — safe to call on boot and after each write. */
export async function refreshParserLabels(): Promise<void> {
  const rows = await CardLabel.find({}).select('label field').lean().exec();
  const overlay: Partial<Record<FieldKey, string[]>> = {};
  for (const r of rows) {
    const f = r.field as FieldKey;
    (overlay[f] ??= []).push(r.label);
  }
  setCustomLabelSynonyms(overlay);
  log.info({ mappings: rows.length }, 'parser_labels_refreshed');
}
