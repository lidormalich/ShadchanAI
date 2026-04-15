// ═══════════════════════════════════════════════════════════
// ShadchanAI — Internal Candidate Router
// ═══════════════════════════════════════════════════════════

import { Router } from 'express';
import * as ctrl from './internal-candidate.controller.js';
import {
  CreateInternalCandidateSchema,
  UpdateInternalCandidateSchema,
  ListInternalCandidatesQuerySchema,
  IdParamSchema,
  CloseCandidateSchema,
  MarkDatingSchema,
  ReopenCandidateSchema,
} from './internal-candidate.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const internalCandidateRouter = Router();

internalCandidateRouter.use(requireAuth);

internalCandidateRouter.get(
  '/',
  validate({ query: ListInternalCandidatesQuerySchema }),
  ctrl.listHandler,
);

internalCandidateRouter.get(
  '/:id',
  validate({ params: IdParamSchema }),
  ctrl.getHandler,
);

internalCandidateRouter.post(
  '/',
  validate({ body: CreateInternalCandidateSchema }),
  ctrl.createHandler,
);

internalCandidateRouter.patch(
  '/:id',
  validate({ params: IdParamSchema, body: UpdateInternalCandidateSchema }),
  ctrl.updateHandler,
);

internalCandidateRouter.post(
  '/:id/archive',
  validate({ params: IdParamSchema }),
  ctrl.archiveHandler,
);

internalCandidateRouter.post(
  '/:id/close',
  validate({ params: IdParamSchema, body: CloseCandidateSchema }),
  ctrl.closeHandler,
);

internalCandidateRouter.post(
  '/:id/mark-dating',
  validate({ params: IdParamSchema, body: MarkDatingSchema }),
  ctrl.markDatingHandler,
);

internalCandidateRouter.post(
  '/:id/reopen',
  validate({ params: IdParamSchema, body: ReopenCandidateSchema }),
  ctrl.reopenHandler,
);

internalCandidateRouter.get(
  '/:id/suggestions',
  validate({ params: IdParamSchema }),
  ctrl.suggestionsHandler,
);

internalCandidateRouter.get(
  '/:id/conversations',
  validate({ params: IdParamSchema }),
  ctrl.conversationsHandler,
);

internalCandidateRouter.get(
  '/:id/readiness',
  validate({ params: IdParamSchema }),
  ctrl.readinessHandler,
);
