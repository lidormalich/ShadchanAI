import { Router } from 'express';
import * as ctrl from './notifications.controller.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get('/', ctrl.listHandler);
