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
import { NotFoundError, ValidationError } from '../../utils/errors.js';

export const mediaRouter = Router();
mediaRouter.use(requireAuth);

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
