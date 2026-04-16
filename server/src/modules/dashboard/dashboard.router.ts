import { Router } from 'express';
import * as ctrl from './dashboard.controller.js';
import { DashboardQueueQuerySchema } from './dashboard.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get('/queue', validate({ query: DashboardQueueQuerySchema }), ctrl.queueHandler);
