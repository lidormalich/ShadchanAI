import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidationError } from '../../utils/errors.js';

// ── Mock the Setting model (settings.service imports it directly
// from ./setting.model.js, not the barrel). ──────────────────
const findOne = vi.fn();
const find = vi.fn();
const findOneAndUpdate = vi.fn();

vi.mock('./setting.model.js', () => ({
  Setting: {
    findOne: (...a: unknown[]) => findOne(...a),
    find: (...a: unknown[]) => find(...a),
    findOneAndUpdate: (...a: unknown[]) => findOneAndUpdate(...a),
  },
}));

import {
  getSettingNumber,
  getSettingBoolean,
  getSettingCached,
  listSettings,
  upsertSetting,
  SETTING_DEFS,
} from './settings.service.js';

/** Helper to stub Setting.findOne().lean().exec() → row */
function stubFindOne(row: unknown) {
  findOne.mockReturnValue({ lean: () => ({ exec: vi.fn().mockResolvedValue(row) }) });
}
function stubFind(rows: unknown[]) {
  find.mockReturnValue({ lean: () => ({ exec: vi.fn().mockResolvedValue(rows) }) });
}

const PERFORMER = '507f1f77bcf86cd799439012';

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════
// getSettingNumber — defaults, coercion guards, range clamping
// ══════════════════════════════════════════════════════════

describe('getSettingNumber', () => {
  it('rejects unknown keys', async () => {
    await expect(getSettingNumber('does.not.exist' as never)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects reading a boolean key as a number', async () => {
    await expect(getSettingNumber('outbound.enabled' as never)).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns the default when no row exists', async () => {
    stubFindOne(null);
    const v = await getSettingNumber('dashboard.awaiting_response_hours');
    expect(v).toBe(SETTING_DEFS['dashboard.awaiting_response_hours'].default);
  });

  it('returns the default when the stored value is not a finite number', async () => {
    stubFindOne({ key: 'dashboard.high_potential_min_score', value: 'nope' });
    expect(await getSettingNumber('dashboard.high_potential_min_score')).toBe(75);
  });

  it('falls back to default when the stored value is out of [min,max]', async () => {
    stubFindOne({ key: 'dashboard.high_potential_min_score', value: 9999 });
    expect(await getSettingNumber('dashboard.high_potential_min_score')).toBe(75);
  });

  it('returns the stored value when it is valid and in range', async () => {
    stubFindOne({ key: 'dashboard.high_potential_min_score', value: 60 });
    expect(await getSettingNumber('dashboard.high_potential_min_score')).toBe(60);
  });
});

// ══════════════════════════════════════════════════════════
// getSettingBoolean
// ══════════════════════════════════════════════════════════

describe('getSettingBoolean', () => {
  it('rejects reading a number key as a boolean', async () => {
    await expect(getSettingBoolean('matching.scan_min_score' as never)).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns the default when no row exists', async () => {
    stubFindOne(null);
    expect(await getSettingBoolean('outbound.enabled')).toBe(false);
    stubFindOne(null);
    expect(await getSettingBoolean('matching.scan_autocreate_enabled')).toBe(true);
  });

  it('ignores a non-boolean stored value and uses the default', async () => {
    stubFindOne({ key: 'outbound.enabled', value: 'true' });
    expect(await getSettingBoolean('outbound.enabled')).toBe(false);
  });

  it('returns the stored boolean when valid', async () => {
    stubFindOne({ key: 'outbound.enabled', value: true });
    expect(await getSettingBoolean('outbound.enabled')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// getSettingCached — TTL cache + write invalidation
// ══════════════════════════════════════════════════════════

describe('getSettingCached', () => {
  it('reads through once then serves from cache (no second DB hit)', async () => {
    // unique key per test run to avoid cross-test cache bleed
    stubFindOne({ key: 'dashboard.deferred_min_age_hours', value: 12 });
    const first = await getSettingCached('dashboard.deferred_min_age_hours');
    expect(first).toBe(12);
    findOne.mockClear();
    const second = await getSettingCached('dashboard.deferred_min_age_hours');
    expect(second).toBe(12);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('upsertSetting invalidates the cache so a fresh value is read next time', async () => {
    stubFindOne({ key: 'dashboard.awaiting_response_hours', value: 10 });
    expect(await getSettingCached('dashboard.awaiting_response_hours')).toBe(10);

    findOneAndUpdate.mockReturnValue({ exec: vi.fn().mockResolvedValue(undefined) });
    await upsertSetting('dashboard.awaiting_response_hours', 20, PERFORMER);

    stubFindOne({ key: 'dashboard.awaiting_response_hours', value: 20 });
    expect(await getSettingCached('dashboard.awaiting_response_hours')).toBe(20);
  });
});

// ══════════════════════════════════════════════════════════
// upsertSetting — validation, coercion, persistence
// ══════════════════════════════════════════════════════════

describe('upsertSetting', () => {
  beforeEach(() => {
    findOneAndUpdate.mockReturnValue({ exec: vi.fn().mockResolvedValue(undefined) });
  });

  it('rejects unknown keys', async () => {
    await expect(upsertSetting('nope', 1, PERFORMER)).rejects.toBeInstanceOf(ValidationError);
  });

  it('coerces "true"/"false"/1/0 to booleans for boolean keys', async () => {
    expect((await upsertSetting('outbound.enabled', 'true', PERFORMER)).value).toBe(true);
    expect((await upsertSetting('outbound.enabled', 'false', PERFORMER)).value).toBe(false);
    expect((await upsertSetting('outbound.enabled', 1, PERFORMER)).value).toBe(true);
    expect((await upsertSetting('outbound.enabled', 0, PERFORMER)).value).toBe(false);
  });

  it('rejects a non-coercible boolean value', async () => {
    await expect(upsertSetting('outbound.enabled', 'maybe', PERFORMER)).rejects.toBeInstanceOf(ValidationError);
  });

  it('coerces numeric strings to numbers for number keys', async () => {
    const r = await upsertSetting('dashboard.high_potential_min_score', '80', PERFORMER);
    expect(r.value).toBe(80);
  });

  it('rejects a non-numeric value for a number key', async () => {
    await expect(upsertSetting('matching.scan_min_score', 'abc', PERFORMER)).rejects.toBeInstanceOf(ValidationError);
  });

  it('enforces the min bound', async () => {
    await expect(upsertSetting('dashboard.awaiting_response_hours', 0, PERFORMER))
      .rejects.toMatchObject({ message: expect.stringContaining('>=') });
  });

  it('enforces the max bound', async () => {
    await expect(upsertSetting('dashboard.high_potential_min_score', 101, PERFORMER))
      .rejects.toMatchObject({ message: expect.stringContaining('<=') });
  });

  it('persists a valid value via findOneAndUpdate upsert', async () => {
    await upsertSetting('matching.scan_min_score', 40, PERFORMER);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = findOneAndUpdate.mock.calls[0]!;
    expect(filter).toEqual({ key: 'matching.scan_min_score' });
    expect((update as { $set: { value: number } }).$set.value).toBe(40);
    expect((opts as { upsert: boolean }).upsert).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// listSettings — merges defaults with stored rows
// ══════════════════════════════════════════════════════════

describe('listSettings', () => {
  it('returns every defined setting, using the default when no row exists', async () => {
    stubFind([]);
    const list = await listSettings();
    expect(list).toHaveLength(Object.keys(SETTING_DEFS).length);
    const awaiting = list.find((s) => s.key === 'dashboard.awaiting_response_hours')!;
    expect(awaiting.value).toBe(48);
  });

  it('overlays stored values of the correct type and ignores type-mismatched rows', async () => {
    stubFind([
      { key: 'dashboard.awaiting_response_hours', value: 100 }, // valid number → applied
      { key: 'outbound.enabled', value: 'true' },              // wrong type → default kept
    ]);
    const list = await listSettings();
    expect(list.find((s) => s.key === 'dashboard.awaiting_response_hours')!.value).toBe(100);
    expect(list.find((s) => s.key === 'outbound.enabled')!.value).toBe(false);
  });
});
