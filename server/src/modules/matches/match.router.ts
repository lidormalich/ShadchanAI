// ═══════════════════════════════════════════════════════════
// ShadchanAI — Match Suggestion Router
// ═══════════════════════════════════════════════════════════

import { Router } from 'express';
import * as ctrl from './match.controller.js';
import {
  ListMatchesQuerySchema,
  EvaluatePairSchema,
  CreateManualSuggestionSchema,
  DeferSchema,
  CloseMatchSchema,
  DeclineSchema,
  IdParamSchema,
  SendProposalSchema,
} from './match.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const matchRouter = Router();
matchRouter.use(requireAuth);

matchRouter.get('/', validate({ query: ListMatchesQuerySchema }), ctrl.listHandler);
matchRouter.get('/:id', validate({ params: IdParamSchema }), ctrl.getHandler);

matchRouter.post('/evaluate', validate({ body: EvaluatePairSchema }), ctrl.evaluateHandler);
matchRouter.get('/find-for/:id', validate({ params: IdParamSchema }), ctrl.findForInternalHandler);
matchRouter.post('/', validate({ body: CreateManualSuggestionSchema }), ctrl.createManualHandler);

matchRouter.post('/:id/approve', validate({ params: IdParamSchema }), ctrl.approveHandler);
matchRouter.post('/:id/decline', validate({ params: IdParamSchema, body: DeclineSchema }), ctrl.declineHandler);
matchRouter.post('/:id/defer', validate({ params: IdParamSchema, body: DeferSchema }), ctrl.deferHandler);
matchRouter.post('/:id/reopen-deferred', validate({ params: IdParamSchema }), ctrl.reopenDeferredHandler);
matchRouter.post('/:id/mark-dating', validate({ params: IdParamSchema }), ctrl.markDatingHandler);
matchRouter.post('/:id/close', validate({ params: IdParamSchema, body: CloseMatchSchema }), ctrl.closeHandler);

matchRouter.get('/:id/explanation', validate({ params: IdParamSchema }), ctrl.explanationHandler);
matchRouter.get('/:id/send-preview', validate({ params: IdParamSchema }), ctrl.sendPreviewHandler);
matchRouter.post('/:id/send-proposal', validate({ params: IdParamSchema, body: SendProposalSchema }), ctrl.sendProposalHandler);
