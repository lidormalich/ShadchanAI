// ═══════════════════════════════════════════════════════════
// Pair Review Router — operator memory for compatibility decisions.
// ═══════════════════════════════════════════════════════════

import { Router } from 'express';
import * as ctrl from './pair-review.controller.js';
import {
  PairReviewParamsSchema,
  InternalIdParamSchema,
  UpsertPairReviewSchema,
} from './pair-review.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const pairReviewRouter = Router();
pairReviewRouter.use(requireAuth);

// All reviews for a single internal candidate (board overlay).
pairReviewRouter.get(
  '/internal/:internalId',
  validate({ params: InternalIdParamSchema }),
  ctrl.listForInternalHandler,
);

// Single pair operations
pairReviewRouter.get(
  '/pair/:internalId/:externalId',
  validate({ params: PairReviewParamsSchema }),
  ctrl.getForPairHandler,
);

pairReviewRouter.put(
  '/pair/:internalId/:externalId',
  validate({ params: PairReviewParamsSchema, body: UpsertPairReviewSchema }),
  ctrl.upsertReviewHandler,
);

pairReviewRouter.delete(
  '/pair/:internalId/:externalId',
  validate({ params: PairReviewParamsSchema }),
  ctrl.clearReviewHandler,
);

// Advisory AI explanation — caches result on the pair review.
pairReviewRouter.post(
  '/pair/:internalId/:externalId/ai-explain',
  validate({ params: PairReviewParamsSchema }),
  ctrl.explainAIHandler,
);
