// ═══════════════════════════════════════════════════════════
// ShadchanAI — Public Photo Link (NO AUTH)
//
// GET /api/public/photo/:token — streams a candidate photo to anyone
// holding the unguessable share token. This is the one intentionally
// public media route: it exists so an operator can drop a photo link
// into a WhatsApp message and the recipient opens it with no login.
//
// Safety: the token is a 24-byte random value (not the candidate id), so
// photos are NOT enumerable, and a link can be revoked by regenerating
// the token. Removing a photo clears the token, so stale links 404.
// ═══════════════════════════════════════════════════════════

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { InternalCandidate, ExternalCandidate } from '../../models/index.js';
import { readCandidatePhoto } from '../../services/storage/candidate-photo.service.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

export const publicPhotoRouter = Router();

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

publicPhotoRouter.get('/photo/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = String(req.params['token'] ?? '');
    if (!TOKEN_RE.test(token)) throw new ValidationError('Invalid token');

    // The token is unique across both collections.
    const [internal, external] = await Promise.all([
      InternalCandidate.findOne({ photoShareToken: token }).select('photoStorageKey').lean().exec(),
      ExternalCandidate.findOne({ photoShareToken: token }).select('photoStorageKey').lean().exec(),
    ]);
    const key = (internal as { photoStorageKey?: string } | null)?.photoStorageKey
      ?? (external as { photoStorageKey?: string } | null)?.photoStorageKey;
    if (!key) throw new NotFoundError('Photo', token);

    const photo = await readCandidatePhoto(key);
    if (!photo) throw new NotFoundError('Photo', token);

    res.setHeader('Content-Type', photo.contentType);
    // Public + cacheable: the token maps to one image; regenerating the
    // token (revoke) mints a new URL, so caching the old one is harmless.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    // Override helmet's same-origin CORP so the image can be embedded /
    // link-previewed anywhere (WhatsApp, another site). This is a
    // deliberately public asset.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(photo.data);
  } catch (e) {
    next(e);
  }
});
