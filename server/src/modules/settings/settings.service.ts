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

export type SettingKey =
  | 'dashboard.awaiting_response_hours'
  | 'dashboard.high_potential_min_score'
  | 'dashboard.deferred_min_age_hours'
  // Pre-pilot safe mode: persisted runtime gate that lives ALONGSIDE
  // the env flag ENABLE_OUTBOUND_MESSAGES. Both must be true to send.
  | 'outbound.enabled';

export interface SettingDef {
  key: SettingKey;
  type: 'number' | 'boolean';
  // For numbers
  min?: number;
  max?: number;
  // Default value (number for numeric keys, boolean for boolean keys)
  default: number | boolean;
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
};

function requireDef(key: string): SettingDef {
  const def = (SETTING_DEFS as Record<string, SettingDef | undefined>)[key];
  if (!def) throw new ValidationError(`Unknown setting key: ${key}`);
  return def;
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

// Backward-compat: dashboard.service still calls getSetting(key) for numbers.
export const getSetting = getSettingNumber;

export async function listSettings(): Promise<Array<SettingDef & { value: number | boolean }>> {
  const rows = await Setting.find({ key: { $in: Object.keys(SETTING_DEFS) } }).lean().exec();
  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  return Object.values(SETTING_DEFS).map((def) => {
    const row = rowByKey.get(def.key);
    let value: number | boolean = def.default;
    if (row) {
      if (def.type === 'number' && typeof row.value === 'number') value = row.value;
      else if (def.type === 'boolean' && typeof row.value === 'boolean') value = row.value;
    }
    return { ...def, value };
  });
}

export async function upsertSetting(
  key: string,
  rawValue: unknown,
  performedBy: string,
): Promise<{ key: SettingKey; value: number | boolean }> {
  const def = requireDef(key);
  let value: number | boolean;

  if (def.type === 'boolean') {
    if (typeof rawValue === 'boolean') value = rawValue;
    else if (rawValue === 'true' || rawValue === 1) value = true;
    else if (rawValue === 'false' || rawValue === 0) value = false;
    else throw new ValidationError(`Value for ${key} must be a boolean`);
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
  return { key: def.key, value };
}
