// ═══════════════════════════════════════════════════════════
// Correct boolean coercion for env vars and query params.
//
// WHY NOT z.coerce.boolean():
//   z.coerce.boolean() runs JS Boolean(value). For the string "false"
//   that is Boolean("false") === true. So FOO=false silently becomes
//   TRUE — inverting kill-switches like ENABLE_OUTBOUND_MESSAGES and
//   AUTH_DEV_HEADER_ALLOWED. These helpers parse the textual forms.
// ═══════════════════════════════════════════════════════════

import { z } from 'zod';

const TRUE_FORMS = new Set(['true', '1', 'yes', 'on']);
const FALSE_FORMS = new Set(['false', '0', 'no', 'off']);

/**
 * Boolean from a string env var with a default. Unset / empty → default.
 * Unrecognised values fall through to a clear z.boolean() type error.
 */
export function booleanString(defaultValue: boolean) {
  return z.preprocess((v) => {
    if (v === undefined || v === null) return defaultValue;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (s === '') return defaultValue;
    if (TRUE_FORMS.has(s)) return true;
    if (FALSE_FORMS.has(s)) return false;
    return v;
  }, z.boolean());
}

/** Optional boolean from a string (e.g. a query param). Unset / empty → undefined. */
export function optionalBooleanString() {
  return z.preprocess((v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (s === '') return undefined;
    if (TRUE_FORMS.has(s)) return true;
    if (FALSE_FORMS.has(s)) return false;
    return v;
  }, z.boolean().optional());
}
