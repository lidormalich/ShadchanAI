// ═══════════════════════════════════════════════════════════
// ShadchanAI — New-candidate manager alert
//
// When a NEW external candidate enters the system (WhatsApp auto-create,
// approved extraction, or manual create) we embed it and check whether it
// has a strong VECTOR (semantic) match to any of the shadchan's active
// internal candidates. If so — and the operator has switched the feature
// on and set a destination number — we WhatsApp the manager the new
// candidate's card + a deep link, headed in bold by the internal it
// matched. Mirrors the "share card" message exactly.
//
// This is the single post-create hook for new externals: it OWNS the
// initial embedding (was scheduleInitialEmbedding) and then, gated on the
// alert setting, runs the match + send. Fire-and-forget; every failure is
// logged and never touches the request that created the candidate.
// ═══════════════════════════════════════════════════════════

import { InternalCandidate, ExternalCandidate, Message } from '../../models/index.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';
import { isSemanticEnabled } from '../embedding/embedding.gate.js';
import { ensureAllChunks, loadChunksForQuery } from '../embedding/embedding.service.js';
import { ALL_CHUNK_TYPES } from '../embedding/embedding.types.js';
import {
  loadInternalChunksMap,
  weightedChunkSimilarity,
} from '../embedding/semantic-similarity.service.js';
import { getSettingBoolean, getSettingString } from '../../modules/settings/settings.service.js';
import { normalizePhone } from '../../utils/phone.js';
import { sendOperatorNotification, phoneToJid } from '../whatsapp/whatsapp.service.js';

const log = createLogger('new-match-alert');

// Strong-match floor for the manager ping — same threshold the "why similar"
// highlights use, and just above the engine's semantic-boost floor (0.7).
const MIN_SIMILARITY = 0.72;
// Cap on internals we ping about per new candidate, so a broad profile
// doesn't fire a burst of messages.
const MAX_ALERTS_PER_CANDIDATE = 3;
// Bound the internal pool we score against (newest first).
const INTERNAL_POOL_CAP = 500;

// Process-local guard against a double-fire for the same candidate (e.g. a
// retried create). Not a durable dedup — the hook is once-per-create anyway.
const alerted = new Set<string>();

/**
 * Post-create hook for a newly entered EXTERNAL candidate: embeds it (the
 * job scheduleInitialEmbedding used to do) and, when the manager-alert
 * setting is on, WhatsApps the configured number a match card. Gated,
 * fire-and-forget, fully swallowed on error.
 */
export function scheduleNewExternalCandidateAlert(externalId: string): void {
  void runNewExternalCandidateAlert(externalId).catch((err) => {
    log.error({ externalId, error: String(err) }, 'new_match_alert_failed');
  });
}

async function runNewExternalCandidateAlert(externalId: string): Promise<void> {
  // Semantic add-on gates BOTH the embedding and the vector match. When it's
  // off there are no vectors to compare — identical to the old behaviour
  // where scheduleInitialEmbedding no-opped.
  if (!(await isSemanticEnabled())) return;

  // Own the initial embedding so the new candidate has vectors to match on.
  await ensureAllChunks(externalId, 'external');

  // Only pay for the match query when the feature is actually armed.
  const enabled = await getSettingBoolean('notifications.new_match_alert_enabled');
  if (!enabled) return;
  const managerPhone = (await getSettingString('notifications.new_match_alert_phone')).trim();
  if (!managerPhone) return;

  if (alerted.has(externalId)) return;

  const matches = await findTopInternalMatches(externalId);
  if (matches.length === 0) return;

  const cardBody = await buildExternalCardBody(externalId);
  if (!cardBody) {
    log.warn({ externalId }, 'new_match_alert_no_card_body');
    return;
  }

  alerted.add(externalId);

  const link = env.PUBLIC_BASE_URL
    ? `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/candidates/external/${externalId}`
    : undefined;

  // Normalize the operator-entered number to E.164 (0501234567 → +972501234567)
  // so a local Israeli format routes correctly; fall back to the raw digits.
  const jid = phoneToJid(normalizePhone(managerPhone) ?? managerPhone);

  for (const m of matches.slice(0, MAX_ALERTS_PER_CANDIDATE)) {
    const body = buildAlertMessage(m.internalName, cardBody, link);
    try {
      // Operator ping — safe-mode-exempt, sends via the match_sending channel
      // when live, else any connected channel.
      await sendOperatorNotification({ jid, body });
      log.info(
        { externalId, internalId: m.internalId, similarity: m.similarity },
        'new_match_alert_sent',
      );
    } catch (err) {
      // No connected channel or a send failure — log and stop; retrying the
      // rest won't help.
      log.warn(
        { externalId, internalId: m.internalId, error: String(err) },
        'new_match_alert_send_failed',
      );
      break;
    }
  }
}

interface InternalMatch {
  internalId: string;
  internalName: string;
  similarity: number;
}

/** Rank the active internal pool (opposite gender) by vector similarity to
 *  the new external, keeping only strong matches. */
async function findTopInternalMatches(externalId: string): Promise<InternalMatch[]> {
  const externalChunks = await loadChunksForQuery(externalId, 'external');
  if (!ALL_CHUNK_TYPES.some((c) => externalChunks[c])) return [];

  const ext = await ExternalCandidate.findById(externalId)
    .select('gender')
    .lean()
    .exec();
  if (!ext) return [];

  const oppositeGender = (ext as { gender?: string }).gender === 'male' ? 'female' : 'male';

  const pool = await InternalCandidate.find({ gender: oppositeGender, status: 'active' })
    .select('firstName lastName')
    .sort({ updatedAt: -1 })
    .limit(INTERNAL_POOL_CAP)
    .lean()
    .exec();
  if (pool.length === 0) return [];

  const internalChunks = await loadInternalChunksMap(pool.map((p) => String(p._id)));

  const rows: InternalMatch[] = [];
  for (const p of pool) {
    const chunks = internalChunks.get(String(p._id));
    if (!chunks) continue;
    const sim = weightedChunkSimilarity(externalChunks, chunks);
    if (sim === undefined || sim < MIN_SIMILARITY) continue;
    const name = `${(p as { firstName?: string }).firstName ?? ''} ${(p as { lastName?: string }).lastName ?? ''}`.trim();
    rows.push({ internalId: String(p._id), internalName: name || 'מועמד/ת', similarity: sim });
  }

  rows.sort((a, b) => b.similarity - a.similarity);
  return rows;
}

/**
 * Builds the card text sent to the manager — the same content the "share
 * card" copies: the original WhatsApp source message verbatim, falling back
 * to a compact card assembled from the candidate's fields.
 */
async function buildExternalCardBody(externalId: string): Promise<string | undefined> {
  const doc = await ExternalCandidate.findById(externalId)
    .select(
      'firstName lastName age city sectorGroup about whatSeeking contactPhone ' +
      'sourceMessageIds rawSourcePayload',
    )
    .lean()
    .exec();
  if (!doc) return undefined;
  const d = doc as Record<string, unknown>;

  // Prefer the raw source message(s) — that's the "כרטיס מקורי" the card tab
  // shows and what the example manager alert reproduces.
  const ids = Array.isArray(d['sourceMessageIds']) ? (d['sourceMessageIds'] as unknown[]) : [];
  if (ids.length) {
    const msgs = await Message.find({ _id: { $in: ids } })
      .select('body mediaCaption createdAt')
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    const text = (msgs as Array<Record<string, unknown>>)
      .map((m) => (m['body'] as string) || (m['mediaCaption'] as string) || '')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }

  const raw = rawPayloadText(d['rawSourcePayload']);
  if (raw) return raw;

  return buildCardFromFields(d);
}

/** Best-effort pull of original card text from a preserved raw payload. */
function rawPayloadText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  for (const key of ['text', 'body', 'rawText', 'message', 'content', 'caption']) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Fallback card when no source text survived — mirrors the client's
 *  buildExternalCardText shape. */
function buildCardFromFields(d: Record<string, unknown>): string | undefined {
  const name = `${(d['firstName'] as string) ?? ''} ${(d['lastName'] as string) ?? ''}`.trim();
  const age = d['age'] as number | undefined;
  const city = d['city'] as string | undefined;
  const about = d['about'] as string | undefined;
  const whatSeeking = d['whatSeeking'] as string | undefined;
  const phone = d['contactPhone'] as string | undefined;

  const lines = [
    name || 'מועמד/ת',
    [age ? `גיל ${age}` : '', city ?? ''].filter(Boolean).join(' · '),
    about ? `\n${about}` : '',
    whatSeeking ? `\nמחפש/ת: ${whatSeeking}` : '',
    phone ? `\nלפרטים נוספים לפנות: ${phone}` : '',
  ].filter(Boolean);

  const text = lines.join('\n').trim();
  return text || undefined;
}

/** Assembles the final WhatsApp message: bold header naming the matched
 *  internal, the card body, then the deep link — matching the share format. */
function buildAlertMessage(internalName: string, cardBody: string, link?: string): string {
  const header = `*נמצאה התאמה עבור המועמד/ת: _${internalName}_ *`;
  const parts = [`${header}\n${cardBody}`];
  if (link) parts.push(`לכרטיס במערכת: ${link}`);
  return parts.join('\n\n');
}
