import { Router } from 'express';
import * as ctrl from './insights.controller.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const insightsRouter = Router();
insightsRouter.use(requireAuth);

insightsRouter.get('/summary', ctrl.summaryHandler);
