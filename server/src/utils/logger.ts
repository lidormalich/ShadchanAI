// ═══════════════════════════════════════════════════════════
// ShadchanAI — Central Logger
//
// A single configured `pino` instance for the whole backend.
// Honors the `LOG_LEVEL` env var for level gating. Use `createLogger(scope)`
// (alias `logger.child({ scope })`) to tag a module name so log
// lines carry a `scope` field for filtering.
//
// In production: default pino JSON (NDJSON), suitable for log shippers.
// In development: a human-readable single line per log via a small custom
// stream (no `pino-pretty` dependency) — e.g.
//   12:34:56 INFO  GET /api/auth/me 304 (88ms)
//   12:34:56 INFO  Connected to MongoDB
// No scope tag and no noisy ids — just time · level · message · key=val.
// ═══════════════════════════════════════════════════════════

import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';

// Read the level straight from process.env rather than the parsed `env`
// config module. The config module is the thing most likely to import the
// logger (and is heavily mocked in tests), so depending on it here would
// create an import-time cycle. `LOG_LEVEL` is validated by config/env.ts;
// here we just fall back to a sane default if it is unset/invalid.
const VALID_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const rawLevel = process.env['LOG_LEVEL'];
const level = rawLevel && VALID_LEVELS.has(rawLevel) ? rawLevel : 'info';

const isProd = process.env['NODE_ENV'] === 'production';
// Pretty in dev unless explicitly disabled (LOG_PRETTY=false) or forced
// on in prod (LOG_PRETTY=true).
const pretty = process.env['LOG_PRETTY']
  ? process.env['LOG_PRETTY'] !== 'false'
  : !isProd;

const LEVEL_LABEL: Record<number, string> = {
  10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL',
};
const LEVEL_COLOR: Record<number, string> = {
  10: '90', 20: '36', 30: '32', 40: '33', 50: '31', 60: '35',
};
// Noise we never print: pino internals, the scope tag (the user doesn't
// want boot/server/db/...), and verbose ids that don't help reading.
const OMIT = new Set([
  'level', 'time', 'scope', 'msg', 'pid', 'hostname', 'v',
  'instanceId', 'requestId', 'nodeEnv', 'env', 'check',
]);

function isEmpty(v: unknown): boolean {
  if (v == null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

function fmtVal(v: unknown): string {
  if (typeof v === 'string') return /\s/.test(v) ? `"${v}"` : v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function prettyLine(raw: string): string {
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { return raw; }

  const color = process.stdout.isTTY;
  const lvlNum = typeof o['level'] === 'number' ? (o['level'] as number) : 30;
  const label = (LEVEL_LABEL[lvlNum] ?? String(lvlNum)).padEnd(5);
  const lvl = color ? `\x1b[${LEVEL_COLOR[lvlNum] ?? '37'}m${label}\x1b[0m` : label;
  const ts = typeof o['time'] === 'number' ? new Date(o['time'] as number).toTimeString().slice(0, 8) : '';

  // HTTP requests read best as a natural line: "GET /api/x 200 (12ms)".
  const perLineOmit = new Set<string>();
  let msg = o['msg'] != null ? String(o['msg']) : '';
  if (o['method'] && o['path'] && o['status'] != null) {
    const dur = o['durationMs'] != null ? ` (${String(o['durationMs'])}ms)` : '';
    msg = `${String(o['method'])} ${String(o['path'])} ${String(o['status'])}${dur}`;
    ['method', 'path', 'status', 'durationMs'].forEach((k) => perLineOmit.add(k));
  }

  const rest = Object.keys(o)
    .filter((k) => !OMIT.has(k) && !perLineOmit.has(k) && !isEmpty(o[k]))
    .map((k) => `${k}=${fmtVal(o[k])}`)
    .join(' ');
  const dim = (s: string) => (color ? `\x1b[90m${s}\x1b[0m` : s);
  return `${dim(ts)} ${lvl} ${msg}${rest ? '  ' + dim(rest) : ''}\n`;
}

// Custom destination: parse each NDJSON line pino emits and rewrite it as a
// readable single line. Splits on newlines in case writes are batched.
function prettyStream(): Writable {
  return new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.trim()) process.stdout.write(prettyLine(line));
      }
      cb();
    },
  });
}

/**
 * The base logger instance. Prefer `createLogger(scope)` so each
 * module's lines are tagged with a `scope`, but the base logger is
 * exported for generic / unscoped logging.
 */
export const logger: Logger = pretty
  ? pino({ level, base: undefined }, prettyStream())
  : pino({ level, base: undefined });

/**
 * Create a scoped child logger. The given `scope` is attached to every
 * line emitted through the returned logger.
 *
 *   const log = createLogger('match.send');
 *   log.info({ matchId }, 'sent proposal');
 */
export function createLogger(scope: string): Logger {
  return logger.child({ scope });
}

export type { Logger };
export default logger;
