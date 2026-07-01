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
  SaveDraftSchema,
  SendProposalSchema,
  AcknowledgeResponseSchema,
  ForceSuggestionSchema,
} from './match.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const matchRouter = Router();
matchRouter.use(requireAuth);

matchRouter.get('/', validate({ query: ListMatchesQuerySchema }), ctrl.listHandler);

// Incremental match scan. Registered BEFORE '/:id' so "scan" is not
// captured by the ObjectId param route.
matchRouter.post('/scan', ctrl.scanHandler);
matchRouter.get('/scan/state', ctrl.scanStateHandler);
matchRouter.get('/scan/results', ctrl.scanResultsHandler);

matchRouter.get('/:id', validate({ params: IdParamSchema }), ctrl.getHandler);

matchRouter.post('/evaluate', validate({ body: EvaluatePairSchema }), ctrl.evaluateHandler);
matchRouter.get('/find-for/:id', validate({ params: IdParamSchema }), ctrl.findForInternalHandler);
matchRouter.get('/find-for/:id/blocked', validate({ params: IdParamSchema }), ctrl.findBlockedForInternalHandler);
matchRouter.post('/', validate({ body: CreateManualSuggestionSchema }), ctrl.createManualHandler);
matchRouter.post('/force', validate({ body: ForceSuggestionSchema }), ctrl.forceSuggestionHandler);

matchRouter.post('/:id/approve', validate({ params: IdParamSchema }), ctrl.approveHandler);
matchRouter.post('/:id/decline', validate({ params: IdParamSchema, body: DeclineSchema }), ctrl.declineHandler);
matchRouter.post('/:id/defer', validate({ params: IdParamSchema, body: DeferSchema }), ctrl.deferHandler);
matchRouter.post('/:id/reopen-deferred', validate({ params: IdParamSchema }), ctrl.reopenDeferredHandler);
matchRouter.post('/:id/mark-dating', validate({ params: IdParamSchema }), ctrl.markDatingHandler);
matchRouter.post('/:id/close', validate({ params: IdParamSchema, body: CloseMatchSchema }), ctrl.closeHandler);

matchRouter.get('/:id/explanation', validate({ params: IdParamSchema }), ctrl.explanationHandler);
matchRouter.post('/:id/explain', validate({ params: IdParamSchema }), ctrl.explainHandler);
matchRouter.get('/:id/send-preview', validate({ params: IdParamSchema }), ctrl.sendPreviewHandler);
matchRouter.patch('/:id/draft', validate({ params: IdParamSchema, body: SaveDraftSchema }), ctrl.saveDraftHandler);
matchRouter.post('/:id/acknowledge-response', validate({ params: IdParamSchema, body: AcknowledgeResponseSchema }), ctrl.acknowledgeResponseHandler);
matchRouter.post('/:id/send-proposal', validate({ params: IdParamSchema, body: SendProposalSchema }), ctrl.sendProposalHandler);
