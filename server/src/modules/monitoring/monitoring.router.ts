import { Router } from 'express';
import * as ctrl from './monitoring.controller.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const monitoringRouter = Router();
monitoringRouter.use(requireAuth);

monitoringRouter.get('/overview', ctrl.overviewHandler);
monitoringRouter.get('/events', ctrl.eventsHandler);
monitoringRouter.get('/ai-usage', ctrl.aiUsageHandler);
