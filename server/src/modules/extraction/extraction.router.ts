import { Router } from 'express';
import * as ctrl from './extraction.controller.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const extractionRouter = Router();
extractionRouter.use(requireAuth);

extractionRouter.get('/review-queue', ctrl.reviewQueueHandler);
extractionRouter.get('/failed-queue', ctrl.failedQueueHandler);
extractionRouter.get('/ingestion-log', ctrl.ingestionLogHandler);
extractionRouter.post('/refresh-all', ctrl.refreshAllHandler);
extractionRouter.post('/requeue-all-failed', ctrl.requeueAllFailedHandler);
extractionRouter.post('/messages/:messageId/run', ctrl.runHandler);
extractionRouter.post('/messages/:messageId/requeue', ctrl.requeueHandler);
extractionRouter.post('/messages/:messageId/approve', ctrl.approveHandler);
extractionRouter.post('/messages/:messageId/reject', ctrl.rejectHandler);
