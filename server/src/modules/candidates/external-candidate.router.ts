// ═══════════════════════════════════════════════════════════
// ShadchanAI — External Candidate Router
// ═══════════════════════════════════════════════════════════

import { Router, raw } from 'express';
import * as ctrl from './external-candidate.controller.js';
import {
  CreateExternalCandidateSchema,
  UpdateExternalCandidateSchema,
  ListExternalCandidatesQuerySchema,
  UpdateShareCardSchema,
  UpdateAvailabilitySchema,
  DetailsCompletedSchema,
  FindMatchingInternalsQuerySchema,
  IdParamSchema,
  AddLearningSchema,
  LearningParamSchema,
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

externalCandidateRouter.post(
  '/:id/photo',
  raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '6mb' }),
  validate({ params: IdParamSchema }),
  ctrl.uploadPhotoHandler,
);

externalCandidateRouter.delete(
  '/:id/photo',
  validate({ params: IdParamSchema }),
  ctrl.removePhotoHandler,
);

externalCandidateRouter.post(
  '/:id/photo/share-link',
  validate({ params: IdParamSchema }),
  ctrl.photoShareLinkHandler,
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

externalCandidateRouter.post(
  '/:id/details-completed',
  validate({ params: IdParamSchema, body: DetailsCompletedSchema }),
  ctrl.detailsCompletedHandler,
);

externalCandidateRouter.get(
  '/:id/source-card',
  validate({ params: IdParamSchema }),
  ctrl.sourceCardHandler,
);

externalCandidateRouter.get(
  '/:id/matching-internals',
  validate({ params: IdParamSchema, query: FindMatchingInternalsQuerySchema }),
  ctrl.matchingInternalsHandler,
);

externalCandidateRouter.get(
  '/:id/learnings',
  validate({ params: IdParamSchema }),
  ctrl.learningsHandler,
);

externalCandidateRouter.post(
  '/:id/learnings',
  validate({ params: IdParamSchema, body: AddLearningSchema }),
  ctrl.addLearningHandler,
);

externalCandidateRouter.delete(
  '/:id/learnings/:learningId',
  validate({ params: LearningParamSchema }),
  ctrl.removeLearningHandler,
);
