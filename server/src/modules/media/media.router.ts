// ═══════════════════════════════════════════════════════════
// ShadchanAI — Media Serving
//
// GET /api/media/:file — streams a stored WhatsApp image (downloaded
// by media.service at ingest time). Auth-gated like every other data
// route; the filename is validated against a strict pattern so path
// traversal is structurally impossible.
// ═══════════════════════════════════════════════════════════

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { readMediaFile, MEDIA_FILENAME_RE } from '../../services/whatsapp/media.service.js';
import { readCandidatePhoto } from '../../services/storage/candidate-photo.service.js';
import { InternalCandidate, ExternalCandidate } from '../../models/index.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

export const mediaRouter = Router();
mediaRouter.use(requireAuth);

const OBJECT_ID_RE = /^[a-f0-9]{24}$/;

// GET /api/media/candidate/:type/:id — streams a candidate's durable photo
// from R2. The stable key is read off the candidate (photoStorageKey), so a
// candidate that changed lifecycle folder is still served by the same URL.
mediaRouter.get('/candidate/:type/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const type = String(req.params['type'] ?? '');
    const id = String(req.params['id'] ?? '');
    if (type !== 'internal' && type !== 'external') {
      throw new ValidationError('Invalid candidate type');
    }
    if (!OBJECT_ID_RE.test(id)) throw new ValidationError('Invalid candidate id');

    const doc = type === 'internal'
      ? await InternalCandidate.findById(id).select('photoStorageKey').lean().exec()
      : await ExternalCandidate.findById(id).select('photoStorageKey').lean().exec();
    const key = (doc as { photoStorageKey?: string } | null)?.photoStorageKey;
    if (!key) throw new NotFoundError('Photo', id);

    const photo = await readCandidatePhoto(key);
    if (!photo) throw new NotFoundError('Photo', id);
    res.setHeader('Content-Type', photo.contentType);
    // Not immutable — the same URL can change when the operator replaces the
    // photo — but short caching is safe and cuts R2 round-trips.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(photo.data);
  } catch (e) {
    next(e);
  }
});

mediaRouter.get('/:file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const file = String(req.params['file'] ?? '');
    if (!MEDIA_FILENAME_RE.test(file)) {
      throw new ValidationError('Invalid media file name');
    }
    const media = await readMediaFile(file);
    if (!media) throw new NotFoundError('Media', file);
    res.setHeader('Content-Type', media.mimeType);
    // Immutable: a media file is written once per message id.
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.send(media.data);
  } catch (e) {
    next(e);
  }
});
