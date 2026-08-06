import { describe, it, expect, vi, beforeEach } from 'vitest';

const readFile = vi.fn();
vi.mock('node:fs/promises', () => ({ readFile: (...a: unknown[]) => readFile(...a) }));

// sharp is native + slow to boot; the HTML path never touches it.
vi.mock('sharp', () => ({ default: () => ({ png: () => ({ toBuffer: async () => Buffer.from('') }) }) }));

const sessionFindOne = vi.fn();
vi.mock('./discovery-session.model.js', () => ({
  DiscoverySession: { findOne: (...a: unknown[]) => sessionFindOne(...a) },
}));

const internalFindById = vi.fn();
vi.mock('../../models/index.js', () => ({
  InternalCandidate: { findById: (...a: unknown[]) => internalFindById(...a) },
}));

const getSettingCached = vi.fn();
vi.mock('../settings/settings.service.js', () => ({
  getSettingCached: (...a: unknown[]) => getSettingCached(...a),
}));

import { buildMeetPageHandler } from './discovery-share.router.js';
import type { Request, Response } from 'express';

const TOKEN = 'PrBIO8bRlamTyCeYXAqn86VQTzdluY5U';

const INDEX_HTML = `<!DOCTYPE html>
<html lang="he" dir="rtl">
  <head>
    <title>שדכןAI — מערכת שידוכים חכמה</title>
    <meta name="description" content="מערכת ניהול שידוכים" />
    <meta property="og:title" content="שדכןAI — מערכת שידוכים חכמה" />
    <meta property="og:image" content="https://shadchan-ai.app/og-image.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="manifest" href="/site.webmanifest" />
  </head>
  <body><div id="root"></div><script type="module" src="/assets/index.js"></script></body>
</html>`;

function stubSession(doc: unknown) {
  sessionFindOne.mockReturnValue({ select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(doc) }) }) });
}
function stubInternal(doc: unknown) {
  internalFindById.mockReturnValue({ select: () => ({ lean: () => ({ exec: vi.fn().mockResolvedValue(doc) }) }) });
}

async function render(token = TOKEN): Promise<string> {
  let body = '';
  const req = {
    params: { token },
    protocol: 'https',
    get: () => 'shadchanai.onrender.com',
  } as unknown as Request;
  const res = {
    setHeader: vi.fn(),
    send: (html: string) => { body = html; },
  } as unknown as Response;
  await buildMeetPageHandler('/dist/index.html')(req, res, vi.fn());
  return body;
}

beforeEach(() => {
  vi.clearAllMocks();
  readFile.mockResolvedValue(INDEX_HTML);
  getSettingCached.mockResolvedValue(true);
});

describe('meet page Open Graph injection', () => {
  it('personalizes the preview with the candidate first name', async () => {
    stubSession({ internalCandidateId: 'i1', status: 'active' });
    stubInternal({ firstName: 'לידור' });

    const html = await render();
    expect(html).toContain('<meta property="og:title" content="שאלון היכרות עבור לידור" />');
    expect(html).toContain('<title>שאלון היכרות עבור לידור</title>');
    expect(html).toContain(`og:url" content="https://shadchanai.onrender.com/meet/${TOKEN}"`);
    expect(html).toContain(`/api/public/discovery/meet-og/${TOKEN}.png`);
    // Discovery links must never be indexed.
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it('removes the generic app-level social tags (no duplicates for the crawler)', async () => {
    stubSession({ internalCandidateId: 'i1', status: 'active' });
    stubInternal({ firstName: 'לידור' });

    const html = await render();
    expect(html).not.toContain('שדכןAI — מערכת שידוכים חכמה');
    expect(html).not.toContain('https://shadchan-ai.app/og-image.png');
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
  });

  it('keeps the SPA body and asset tags untouched', async () => {
    stubSession({ internalCandidateId: 'i1', status: 'active' });
    stubInternal({ firstName: 'לידור' });

    const html = await render();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/assets/index.js"');
    expect(html).toContain('rel="manifest"');
  });

  it('falls back to neutral copy for an unknown token — never leaks that it is invalid', async () => {
    stubSession(null);
    const html = await render();
    expect(html).toContain('היכרות חכמה — שדכןAI');
    expect(html).not.toContain('שאלון היכרות עבור');
  });

  it('uses neutral copy for a revoked link (a preview must not confirm the token existed)', async () => {
    stubSession({ internalCandidateId: 'i1', status: 'revoked' });
    stubInternal({ firstName: 'לידור' });
    const html = await render();
    expect(html).not.toContain('לידור');
  });

  it('uses neutral copy for a malformed token without hitting the DB', async () => {
    const html = await render('short');
    expect(html).toContain('היכרות חכמה — שדכןAI');
    expect(sessionFindOne).not.toHaveBeenCalled();
  });

  it('escapes a name containing HTML so it cannot break out of the attribute', async () => {
    stubSession({ internalCandidateId: 'i1', status: 'active' });
    stubInternal({ firstName: '"><script>alert(1)</script>' });

    const html = await render();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('degrades to neutral copy when the lookup throws', async () => {
    sessionFindOne.mockImplementation(() => { throw new Error('db down'); });
    const html = await render();
    expect(html).toContain('היכרות חכמה — שדכןAI');
  });
});
