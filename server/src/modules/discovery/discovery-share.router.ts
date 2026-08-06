// ═══════════════════════════════════════════════════════════
// Discovery link previews (Open Graph / WhatsApp).
//
// WhatsApp, Telegram and iMessage crawlers do NOT run JavaScript —
// they fetch the URL once and read the <head>. Because /meet/:token
// is served by the SPA fallback, every discovery link previewed as
// the generic app card ("שדכןAI — מערכת שידוכים חכמה"), which is both
// unhelpful and, worse, makes a personal invitation look like an ad.
//
// This router intercepts GET /meet/:token BEFORE the SPA fallback and
// returns the SAME index.html with the OG/Twitter tags rewritten for
// that specific session ("שאלון היכרות עבור לידור"). The document body
// is untouched, so the candidate's browser boots the identical SPA —
// only the crawler-visible metadata differs.
//
// PII: the preview shows the internal candidate's FIRST NAME only —
// the same name the page itself greets them with. Nothing about the
// suggested matches ever appears in a link preview. Invalid, revoked
// and expired tokens fall back to neutral copy that leaks nothing
// (a preview must never confirm whether a token is real).
// ═══════════════════════════════════════════════════════════

import { Router, type Request, type Response, type NextFunction } from 'express';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { InternalCandidate } from '../../models/index.js';
import { DiscoverySession } from './discovery-session.model.js';
import { TOKEN_RE } from './discovery-session.service.js';
import { getSettingCached } from '../settings/settings.service.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('discovery.share');

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
// Crawlers re-fetch previews rarely; an hour keeps a regenerated link
// fresh without hammering the DB on every share.
const PREVIEW_CACHE = 'public, max-age=3600';

/** Escapes text for safe interpolation into HTML attributes / SVG text. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface PreviewCopy {
  title: string;
  description: string;
  firstName?: string | undefined;
}

/**
 * Resolves the preview copy for a token. Deliberately forgiving: any
 * problem (bad token, revoked, expired, feature off, DB hiccup) yields
 * the neutral invitation rather than an error — a broken preview would
 * make a legitimate link look suspicious in the chat.
 */
async function resolvePreview(token: string): Promise<PreviewCopy> {
  const neutral: PreviewCopy = {
    title: 'היכרות חכמה — שדכןAI',
    description: 'כמה שאלות קצרות שיעזרו לנו להבין מה באמת מתאים לך, ואז הצעות מותאמות אישית.',
  };

  try {
    if (!TOKEN_RE.test(token)) return neutral;
    if (!(await getSettingCached('discovery.enabled'))) return neutral;

    const session = await DiscoverySession.findOne({ token })
      .select('internalCandidateId status')
      .lean()
      .exec();
    // Revoked links keep the neutral card: the preview must not
    // confirm that a token ever existed.
    if (!session || session.status === 'revoked') return neutral;

    const internal = await InternalCandidate.findById(session.internalCandidateId)
      .select('firstName')
      .lean()
      .exec();
    const firstName = internal?.firstName?.trim();
    if (!firstName) return neutral;

    return {
      firstName,
      title: `שאלון היכרות עבור ${firstName}`,
      description:
        'הכנו עבורך חוויה קצרה: כמה שאלות על מה שחשוב לך, ואז הצעות אנונימיות שאפשר לסמן מתאים / לא מתאים. ההעדפות נשמרות רק עבור השדכן/ית שלך.',
    };
  } catch (err) {
    log.warn({ error: String(err) }, 'meet_preview_resolve_failed');
    return neutral;
  }
}

// ── OG image (generated, no design assets needed) ────────

function ogSvg(firstName?: string): string {
  const headline = firstName ? `שאלון היכרות עבור ${esc(firstName)}` : 'היכרות חכמה';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#4f46e5"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#bg)"/>
  <circle cx="1040" cy="120" r="220" fill="#ffffff" opacity="0.07"/>
  <circle cx="160" cy="560" r="180" fill="#ffffff" opacity="0.06"/>
  <text x="${OG_WIDTH / 2}" y="250" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
        font-size="86" font-weight="bold" fill="#ffffff" direction="rtl">${headline}</text>
  <text x="${OG_WIDTH / 2}" y="340" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
        font-size="42" fill="#e9e5ff" direction="rtl">כמה שאלות קצרות — ואז הצעות מותאמות אישית</text>
  <text x="${OG_WIDTH / 2}" y="530" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"
        font-size="34" fill="#ffffff" opacity="0.85" direction="rtl">שדכןAI · היכרות חכמה</text>
</svg>`;
}

export const discoveryShareRouter = Router();

/**
 * Generated preview image. Keyed by token so each candidate's card
 * carries their own name; the token is not otherwise used, and the
 * image reveals nothing beyond the first name.
 */
discoveryShareRouter.get(
  '/meet-og/:token.png',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = String(req.params['token'] ?? '');
      const { firstName } = await resolvePreview(token);
      const png = await sharp(Buffer.from(ogSvg(firstName))).png().toBuffer();
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', PREVIEW_CACHE);
      // Crawlers fetch from their own origin — allow embedding.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.send(png);
    } catch (e) { next(e); }
  },
);

/**
 * Builds the /meet/:token HTML handler over an existing index.html.
 * app.ts only mounts it when a client build is present — in local dev
 * the SPA is served by Vite, so there is no index.html to rewrite.
 */
export function buildMeetPageHandler(indexHtmlPath: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = String(req.params['token'] ?? '');
      const [html, preview] = await Promise.all([
        readFile(indexHtmlPath, 'utf8'),
        resolvePreview(token),
      ]);

      const base = (env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const url = `${base}/meet/${encodeURIComponent(token)}`;
      const image = `${base}/api/public/discovery/meet-og/${encodeURIComponent(token)}.png`;

      // Drop the generic app-level social tags, then inject the
      // session-specific ones. Everything else (scripts, fonts,
      // favicons) is left exactly as the build produced it.
      const stripped = html
        .replace(/[ \t]*<meta\s+property="og:[^"]*"[^>]*>\s*\n?/g, '')
        .replace(/[ \t]*<meta\s+name="twitter:[^"]*"[^>]*>\s*\n?/g, '')
        .replace(/[ \t]*<meta\s+name="description"[^>]*>\s*\n?/g, '');

      const tags = `
    <meta name="description" content="${esc(preview.description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="שדכןAI" />
    <meta property="og:locale" content="he_IL" />
    <meta property="og:title" content="${esc(preview.title)}" />
    <meta property="og:description" content="${esc(preview.description)}" />
    <meta property="og:url" content="${esc(url)}" />
    <meta property="og:image" content="${esc(image)}" />
    <meta property="og:image:width" content="${OG_WIDTH}" />
    <meta property="og:image:height" content="${OG_HEIGHT}" />
    <meta property="og:image:alt" content="${esc(preview.title)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(preview.title)}" />
    <meta name="twitter:description" content="${esc(preview.description)}" />
    <meta name="twitter:image" content="${esc(image)}" />
    <meta name="robots" content="noindex, nofollow" />
`;

      const withTitle = stripped.replace(
        /<title>[\s\S]*?<\/title>/,
        `<title>${esc(preview.title)}</title>`,
      );
      const out = withTitle.replace('</head>', `${tags}  </head>`);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // Private: the HTML embeds a token-specific preview. Short TTL so
      // a revoked link stops advertising a name quickly.
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(out);
    } catch (e) { next(e); }
  };
}
