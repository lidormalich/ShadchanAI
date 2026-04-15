// ═══════════════════════════════════════════════════════════
// ShadchanAI — External Candidate Router
// ═══════════════════════════════════════════════════════════

import { Router } from 'express';
import * as ctrl from './external-candidate.controller.js';
import {
  CreateExternalCandidateSchema,
  UpdateExternalCandidateSchema,
  ListExternalCandidatesQuerySchema,
  UpdateShareCardSchema,
  UpdateAvailabilitySchema,
  FindMatchingInternalsQuerySchema,
  IdParamSchema,
} from './external-candidate.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const externalCandidateRouter = Router();

externalCandidateRouter.use(requireAuth);

externalCandidateRouter.get(
  '/',
  validate({ query: ListExternalCandidatesQuerySchema }),
  ctrl.listHandler,
);

externalCandidateRouter.get(
  '/:id',
  validate({ params: IdParamSchema }),
  ctrl.getHandler,
);

externalCandidateRouter.post(
  '/',
  validate({ body: CreateExternalCandidateSchema }),
  ctrl.createHandler,
);

externalCandidateRouter.patch(
  '/:id',
  validate({ params: IdParamSchema, body: UpdateExternalCandidateSchema }),
  ctrl.updateHandler,
);

externalCandidateRouter.post(
  '/:id/archive',
  validate({ params: IdParamSchema }),
  ctrl.archiveHandler,
);

externalCandidateRouter.patch(
  '/:id/share-card',
  validate({ params: IdParamSchema, body: UpdateShareCardSchema }),
  ctrl.shareCardHandler,
);

externalCandidateRouter.patch(
  '/:id/availability',
  validate({ params: IdParamSchema, body: UpdateAvailabilitySchema }),
  ctrl.availabilityHandler,
);

externalCandidateRouter.get(
  '/:id/matching-internals',
  validate({ params: IdParamSchema, query: FindMatchingInternalsQuerySchema }),
  ctrl.matchingInternalsHandler,
);
