// ═══════════════════════════════════════════════════════════
// Settings service (Phase 5).
//
// Key/value store for a small, explicit allow-list of operator-
// editable settings. Unknown keys are rejected to keep this from
// drifting into a "dump anything" bucket.
//
// Today only dashboard thresholds are editable. The matching
// engine's weights are still hardcoded — wiring those to this
// collection is a Phase 6+ migration.
// ═══════════════════════════════════════════════════════════

import { Types } from 'mongoose';
import { Setting } from './setting.model.js';
import { ValidationError } from '../../utils/errors.js';
import { env } from '../../config/env.js';

export type SettingKey =
  | 'dashboard.awaiting_response_hours'
  | 'dashboard.high_potential_min_score'
  | 'dashboard.deferred_min_age_hours'
  // Pre-pilot safe mode: persisted runtime gate that lives ALONGSIDE
  // the env flag ENABLE_OUTBOUND_MESSAGES. Both must be true to send.
  | 'outbound.enabled'
  // Incremental match-scan tuning. Consumed by the scan service
  // (services/matching/match-scan.service.ts), NOT the sync engine —
  // the engine still runs discovery mode (floor 30) and the scan
  // applies these as an additional, operator-controlled gate.
  | 'matching.scan_min_score'
  | 'matching.scan_autocreate_enabled'
  | 'matching.scan_autocreate_min_score'
  // Which AI engine is primary. Overrides the AI_ENGINE env default at
  // runtime; consumed by services/ai/ai.service.ts.
  | 'ai.engine'
  // Daily cap on provider-hitting AI requests (cache hits are free).
  // Overrides the AI_DAILY_REQUEST_BUDGET env default at runtime.
  | 'ai.daily_request_budget'
  // Vision extraction for image-only profile cards (OpenAI multimodal).
  | 'ai.vision_extract_enabled'
  // Pairs re-score automatically once their cached score is older than
  // this many days (time-based penalties drift otherwise).
  | 'matching.rescore_ttl_days'
  // Extraction pipeline thresholds (services/extraction/orchestrator.ts).
  | 'extraction.auto_create_confidence'
  | 'extraction.regex_skip_ai_confidence'
  // Candidate learning agent (services/ai/candidate-learning.service.ts).
  | 'learning.refresh_enabled'
  | 'learning.refresh_limit';

export interface SettingDef {
  key: SettingKey;
  type: 'number' | 'boolean' | 'enum';
  // For numbers
  min?: number;
  max?: number;
  // For enums: the allowed values
  options?: string[];
  // Default value (typed per `type`)
  default: number | boolean | string;
  description: string;
}

export const SETTING_DEFS: Record<SettingKey, SettingDef> = {
  'dashboard.awaiting_response_hours': {
    key: 'dashboard.awaiting_response_hours',
    type: 'number', min: 1, max: 720, default: 48,
    description: 'שעות ללא תגובה לפני שההצעה מופיעה בתור כ"ממתין לתגובה"',
  },
  'dashboard.high_potential_min_score': {
    key: 'dashboard.high_potential_min_score',
    type: 'number', min: 0, max: 100, default: 75,
    description: 'ציון מינימלי לסימון "הצעה בציון גבוה" בתור הדשבורד',
  },
  'dashboard.deferred_min_age_hours': {
    key: 'dashboard.deferred_min_age_hours',
    type: 'number', min: 0, max: 720, default: 24,
    description: 'שעות מההשהיה לפני שההצעה מופיעה שוב בתור ("לבדוק שוב")',
  },
  'outbound.enabled': {
    key: 'outbound.enabled',
    type: 'boolean',
    default: false,
    description: 'Persisted runtime kill-switch for outbound WhatsApp messages. Must be true AND ENABLE_OUTBOUND_MESSAGES env must be true to allow sending.',
  },
  'matching.scan_min_score': {
    key: 'matching.scan_min_score',
    type: 'number', min: 0, max: 100, default: 55,
    description: 'ציון מינימלי להצעה — זוגות מתחת אליו לא מוצגים בתיבת ההצעות הממתינות (ניתן לעקוף עם מסנן הציון)',
  },
  'matching.scan_autocreate_enabled': {
    key: 'matching.scan_autocreate_enabled',
    type: 'boolean',
    // Default OFF: the scan feeds the discovery inbox; the shadchan accepts
    // proposals into the pipeline. Turn ON for automatic drafting of strong
    // eligible pairs (above scan_autocreate_min_score).
    default: false,
    description: 'יצירת טיוטות הצעה אוטומטית בסריקה (כבוי = הצעות נכנסות לתיבת הגילוי לאישור ידני)',
  },
  'matching.scan_autocreate_min_score': {
    key: 'matching.scan_autocreate_min_score',
    type: 'number', min: 0, max: 100, default: 45,
    description: 'ציון מינימלי ליצירת טיוטת הצעה אוטומטית בסריקה',
  },
  'ai.engine': {
    key: 'ai.engine',
    type: 'enum',
    options: ['groq', 'openai'],
    // The deploy-time env var is the default; this setting overrides it.
    default: env.AI_ENGINE,
    description: 'מנוע ה-AI הראשי: Groq (חינמי, מהיר) או OpenAI (בתשלום). המנוע השני משמש כגיבוי אוטומטי.',
  },
  'ai.daily_request_budget': {
    key: 'ai.daily_request_budget',
    type: 'number', min: 0, max: 100_000,
    default: env.AI_DAILY_REQUEST_BUDGET,
    description: 'תקרת בקשות AI יומית (הגנת עלות). 0 = ללא הגבלה. פגיעות cache לא נספרות.',
  },
  'ai.vision_extract_enabled': {
    key: 'ai.vision_extract_enabled',
    type: 'boolean',
    default: env.WA_VISION_EXTRACT,
    description: 'חילוץ פרופילים מכרטיסי-תמונה (ללא טקסט) באמצעות OpenAI. דורש מפתח OpenAI; התוצאה תמיד עוברת אישור ידני.',
  },
  'matching.rescore_ttl_days': {
    key: 'matching.rescore_ttl_days',
    type: 'number', min: 1, max: 90, default: 7,
    description: 'כל כמה ימים לחשב מחדש ציון של זוג גם בלי שינוי בנתונים (קנסות תלויי-זמן מתעדכנים)',
  },
  'extraction.auto_create_confidence': {
    key: 'extraction.auto_create_confidence',
    type: 'number', min: 0, max: 1, default: 0.7,
    description: 'סף ביטחון ליצירת מועמד אוטומטית מהודעת וואטסאפ; מתחתיו — לבדיקה ידנית',
  },
  'extraction.regex_skip_ai_confidence': {
    key: 'extraction.regex_skip_ai_confidence',
    type: 'number', min: 0, max: 1, default: 0.8,
    description: 'סף ביטחון של חילוץ ה-regex שמעליו מדלגים על קריאת AI (כרטיס מלא ומובנה)',
  },
  'learning.refresh_enabled': {
    key: 'learning.refresh_enabled',
    type: 'boolean',
    default: true,
    description: 'סוכן הלמידה: רענון אוטומטי (שעתי) של תובנות "מה למדנו" למועמדים עם פידבק חדש',
  },
  'learning.refresh_limit': {
    key: 'learning.refresh_limit',
    type: 'number', min: 1, max: 100, default: 15,
    description: 'כמה מועמדים לכל היותר לרענן בכל ריצת למידה (הגנת עלות)',
  },
};

function requireDef(key: string): SettingDef {
  const def = (SETTING_DEFS as Record<string, SettingDef | undefined>)[key];
  if (!def) throw new ValidationError(`Unknown setting key: ${key}`);
  return def;
}

// ── In-memory TTL cache ─────────────────────────────────────
// Rarely-changing settings (e.g. dashboard thresholds) are read on
// every dashboard load. Cache the resolved value per key for a short
// TTL to avoid a Setting.findOne() per read. Writes invalidate the
// affected key (see upsertSetting) so updates take effect immediately.
const SETTING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const settingCache = new Map<SettingKey, { value: number | boolean; expiresAt: number }>();

/**
 * Cached read of a setting's resolved value. On a cache miss (or expiry)
 * it falls through to the existing typed getters and populates the cache.
 * Use for hot, rarely-changing reads; for always-fresh reads call the
 * underlying getSettingNumber / getSettingBoolean directly.
 */
export async function getSettingCached(key: SettingKey): Promise<number | boolean> {
  const cached = settingCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const def = requireDef(key);
  const value = def.type === 'number'
    ? await getSettingNumber(key)
    : await getSettingBoolean(key);

  settingCache.set(key, { value, expiresAt: Date.now() + SETTING_CACHE_TTL_MS });
  return value;
}

export async function getSettingNumber(key: SettingKey): Promise<number> {
  const def = requireDef(key);
  if (def.type !== 'number') throw new ValidationError(`${key} is not a number setting`);
  const row = await Setting.findOne({ key }).lean().exec();
  if (!row || typeof row.value !== 'number' || !Number.isFinite(row.value)) {
    return def.default as number;
  }
  if (def.min !== undefined && row.value < def.min) return def.default as number;
  if (def.max !== undefined && row.value > def.max) return def.default as number;
  return row.value;
}

export async function getSettingBoolean(key: SettingKey): Promise<boolean> {
  const def = requireDef(key);
  if (def.type !== 'boolean') throw new ValidationError(`${key} is not a boolean setting`);
  const row = await Setting.findOne({ key }).lean().exec();
  if (!row || typeof row.value !== 'boolean') return def.default as boolean;
  return row.value;
}

export async function getSettingString(key: SettingKey): Promise<string> {
  const def = requireDef(key);
  if (def.type !== 'enum') throw new ValidationError(`${key} is not an enum setting`);
  const fallback = def.default as string;
  const row = await Setting.findOne({ key }).lean().exec();
  if (!row || typeof row.value !== 'string') return fallback;
  if (def.options && !def.options.includes(row.value)) return fallback;
  return row.value;
}

// String settings get their own short-TTL cache so hot reads (e.g. the AI
// engine on every AI call) don't hit the DB each time. Writes invalidate.
const settingStringCache = new Map<SettingKey, { value: string; expiresAt: number }>();

export async function getSettingStringCached(key: SettingKey): Promise<string> {
  const cached = settingStringCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await getSettingString(key);
  settingStringCache.set(key, { value, expiresAt: Date.now() + SETTING_CACHE_TTL_MS });
  return value;
}

// Backward-compat: dashboard.service still calls getSetting(key) for numbers.
export const getSetting = getSettingNumber;

export async function listSettings(): Promise<Array<SettingDef & { value: number | boolean | string }>> {
  const rows = await Setting.find({ key: { $in: Object.keys(SETTING_DEFS) } }).lean().exec();
  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  return Object.values(SETTING_DEFS).map((def) => {
    const row = rowByKey.get(def.key);
    let value: number | boolean | string = def.default;
    if (row) {
      if (def.type === 'number' && typeof row.value === 'number') value = row.value;
      else if (def.type === 'boolean' && typeof row.value === 'boolean') value = row.value;
      else if (def.type === 'enum' && typeof row.value === 'string') value = row.value;
    }
    return { ...def, value };
  });
}

export async function upsertSetting(
  key: string,
  rawValue: unknown,
  performedBy: string,
): Promise<{ key: SettingKey; value: number | boolean | string }> {
  const def = requireDef(key);
  let value: number | boolean | string;

  if (def.type === 'boolean') {
    if (typeof rawValue === 'boolean') value = rawValue;
    else if (rawValue === 'true' || rawValue === 1) value = true;
    else if (rawValue === 'false' || rawValue === 0) value = false;
    else throw new ValidationError(`Value for ${key} must be a boolean`);
  } else if (def.type === 'enum') {
    const s = String(rawValue);
    if (!def.options || !def.options.includes(s)) {
      throw new ValidationError(`Value for ${key} must be one of: ${def.options?.join(', ') ?? ''}`);
    }
    value = s;
  } else {
    const n = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(n)) throw new ValidationError(`Value for ${key} must be a number`);
    if (def.min !== undefined && n < def.min) throw new ValidationError(`Value for ${key} must be >= ${def.min}`);
    if (def.max !== undefined && n > def.max) throw new ValidationError(`Value for ${key} must be <= ${def.max}`);
    value = n;
  }

  await Setting.findOneAndUpdate(
    { key },
    { $set: { value, updatedBy: new Types.ObjectId(performedBy) } },
    { upsert: true, new: true },
  ).exec();

  // Invalidate both caches so the new value is read immediately.
  settingCache.delete(def.key);
  settingStringCache.delete(def.key);
  return { key: def.key, value };
}
