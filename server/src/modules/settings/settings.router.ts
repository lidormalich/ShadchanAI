import { Router } from 'express';
import * as ctrl from './settings.controller.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get('/', ctrl.listHandler);
settingsRouter.patch('/:key', ctrl.upsertHandler);
