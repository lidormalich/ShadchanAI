import { Router } from 'express';
import * as ctrl from './audit.controller.js';
import { ListAuditLogsQuerySchema } from './audit.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const auditRouter = Router();
auditRouter.use(requireAuth);

auditRouter.get('/', validate({ query: ListAuditLogsQuerySchema }), ctrl.listHandler);
