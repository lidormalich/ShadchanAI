// ═══════════════════════════════════════════════════════════
// Backfill: translate persisted English match-suggestion text to Hebrew.
//
// overrideReasons / blocker messages are SNAPSHOTTED onto each
// MatchSuggestion when it is scored. Older documents therefore still
// carry the English strings that were generated before the engine was
// translated — the UI shows them verbatim. This script rewrites those
// stored strings in place. It does NOT re-score (numbers are untouched);
// it only translates the display text.
//
// Fields rewritten per document:
//   - overrideReasons[]        (rendered on the match detail page)
//   - blockers[].message       (stored blocker prose)
//   - hardBlockers[]           (stored blocker prose)
//
// Usage:
//   DRY_RUN=true npx tsx src/scripts/translate-override-reasons.ts
//                npx tsx src/scripts/translate-override-reasons.ts
// ═══════════════════════════════════════════════════════════

import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { MatchSuggestion } from '../models/index.js';

const DRY_RUN = process.env['DRY_RUN'] === 'true';

// ── Hebrew label maps (mirror matching.rules.ts) ──────────
const GENDER_HE: Record<string, string> = { male: 'גבר', female: 'אישה' };
const PERSONAL_STATUS_HE: Record<string, string> = {
  single: 'רווק/ה', divorced: 'גרוש/ה', widowed: 'אלמן/ה', separated: 'פרוד/ה',
};
const CANDIDATE_STATUS_HE: Record<string, string> = {
  active: 'פעיל', paused: 'בהשהיה', dating: 'בהיכרות', closed: 'סגור', archived: 'בארכיון',
};
const he = (map: Record<string, string>, v: string | undefined): string => (v ? map[v] ?? v : '');

// Translate a single English blocker message to its Hebrew form. Returns
// the input unchanged if it doesn't match a known English pattern (e.g.
// it's already Hebrew, or an operator-typed justification).
function translateBlockerMessage(msg: string): string {
  let m: RegExpMatchArray | null;

  if ((m = msg.match(/^Same gender \((\w+)\)$/))) return `שני הצדדים מאותו מין (${he(GENDER_HE, m[1])})`;
  if ((m = msg.match(/^Internal candidate status is '(\w+)'$/))) return `המועמד הפנימי אינו פעיל (סטטוס: ${he(CANDIDATE_STATUS_HE, m[1])})`;
  if ((m = msg.match(/^External candidate status is '(\w+)'$/))) return `המועמד החיצוני אינו פעיל (סטטוס: ${he(CANDIDATE_STATUS_HE, m[1])})`;
  if (msg === 'External candidate is marked unavailable') return 'המועמד החיצוני מסומן כלא זמין';
  if (msg === 'External candidate is currently dating') return 'המועמד החיצוני נמצא כעת בהיכרות';
  if (msg === 'Internal candidate is already in an active dating relationship') return 'המועמד הפנימי כבר נמצא בקשר היכרות פעיל';
  if (msg === 'An active suggestion already exists for this pair') return 'כבר קיימת הצעה פעילה לזוג הזה';
  if ((m = msg.match(/^Pair was declined (\d+) days ago \(cooldown: (\d+) days\)$/))) return `הזוג נדחה לפני ${m[1]} ימים (תקופת צינון: ${m[2]} ימים)`;
  if ((m = msg.match(/^Internal hard constraint violated: (.+)$/s))) return `הופר אילוץ קשיח של הצד הפנימי: ${m[1]}`;
  if ((m = msg.match(/^External hard constraint violated: (.+)$/s))) return `הופר אילוץ קשיח של הצד החיצוני: ${m[1]}`;
  if ((m = msg.match(/^External candidate explicitly not open to (\w+) candidates$/))) return `המועמד החיצוני ציין במפורש שאינו פתוח למועמדים בסטטוס ${he(PERSONAL_STATUS_HE, m[1])}`;
  if ((m = msg.match(/^Internal candidate not open to (\w+) candidates$/))) return `המועמד הפנימי אינו פתוח למועמדים בסטטוס ${he(PERSONAL_STATUS_HE, m[1])}`;
  if (msg === 'Internal candidate has explicit hard constraint against widowed candidates') return 'למועמד הפנימי אילוץ קשיח מפורש נגד מועמדים אלמנים';
  if ((m = msg.match(/^Internal candidate explicitly not open to candidates with children \((\w+) profile flagged\)$/))) return `המועמד הפנימי אינו פתוח למועמדים עם ילדים (סומן פרופיל ${he(PERSONAL_STATUS_HE, m[1])})`;

  return msg;
}

// Translate one overrideReasons[] entry. Handles the scoring reasons, the
// forced-override prefixes, and the "blocker: CODE — <english>" lines.
function translateOverrideReason(reason: string): string {
  if (reason === 'Second-chapter case: relaxed age and sector scoring applied') return 'פרק ב׳: הוחל ניקוד מקל לגיל ולמגזר';
  if (reason === 'Discovery mode: widened age range considered') return 'מצב גילוי: נשקל טווח גילאים מורחב';

  let m: RegExpMatchArray | null;
  if ((m = reason.match(/^forced \(refreshed existing\): (.*)$/s))) return `נכפה ידנית (רענון הצעה קיימת): ${m[1]}`;
  if ((m = reason.match(/^forced: (.*)$/s))) return `נכפה ידנית: ${m[1]}`;
  // Old shape: "blocker: <CODE> — <english message>" → "חסם: <hebrew message>"
  if ((m = reason.match(/^blocker: \S+ — (.+)$/s))) return `חסם: ${translateBlockerMessage(m[1]!)}`;

  return reason;
}

interface Stats {
  scanned: number;
  changed: number;
  overrideReasonsChanged: number;
  blockerMessagesChanged: number;
  hardBlockersChanged: number;
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  console.error(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);

  const s: Stats = { scanned: 0, changed: 0, overrideReasonsChanged: 0, blockerMessagesChanged: 0, hardBlockersChanged: 0 };
  const cursor = MatchSuggestion.find({}).select('_id overrideReasons blockers hardBlockers').cursor();

  for await (const doc of cursor) {
    s.scanned += 1;
    let touched = false;

    const newOverride = (doc.overrideReasons ?? []).map(translateOverrideReason);
    if (newOverride.some((v, i) => v !== doc.overrideReasons[i])) {
      doc.overrideReasons = newOverride;
      s.overrideReasonsChanged += 1;
      touched = true;
    }

    const newHard = (doc.hardBlockers ?? []).map(translateBlockerMessage);
    if (newHard.some((v, i) => v !== doc.hardBlockers[i])) {
      doc.hardBlockers = newHard;
      s.hardBlockersChanged += 1;
      touched = true;
    }

    let blockerTouched = false;
    for (const b of doc.blockers ?? []) {
      const t = translateBlockerMessage(b.message);
      if (t !== b.message) { b.message = t; blockerTouched = true; }
    }
    if (blockerTouched) { doc.markModified('blockers'); s.blockerMessagesChanged += 1; touched = true; }

    if (touched) {
      s.changed += 1;
      if (!DRY_RUN) await doc.save();
    }
  }

  console.error(JSON.stringify(s, null, 2));
  console.error(DRY_RUN ? 'Dry run: no writes were performed.' : 'Translation applied.');
  await mongoose.disconnect();
}

void main().catch((e) => {
  console.error('translate-override-reasons failed:', e);
  process.exit(1);
});
