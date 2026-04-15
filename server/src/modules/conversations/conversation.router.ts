import { Router } from 'express';
import * as ctrl from './conversation.controller.js';
import {
  ListConversationsQuerySchema,
  ListMessagesQuerySchema,
  LinkConversationSchema,
  IdParamSchema,
  SendConvoMessageSchema,
} from './conversation.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const conversationRouter = Router();
conversationRouter.use(requireAuth);

conversationRouter.get('/', validate({ query: ListConversationsQuerySchema }), ctrl.listHandler);
conversationRouter.get('/role/:role', validate({ query: ListConversationsQuerySchema }), ctrl.byRoleHandler);
conversationRouter.get('/:id', validate({ params: IdParamSchema }), ctrl.getHandler);
conversationRouter.get('/:id/chain', validate({ params: IdParamSchema }), ctrl.chainHandler);
conversationRouter.get('/:id/messages', validate({ params: IdParamSchema, query: ListMessagesQuerySchema }), ctrl.listMessagesHandler);
conversationRouter.post('/:id/mark-read', validate({ params: IdParamSchema }), ctrl.markReadHandler);
conversationRouter.patch('/:id/link', validate({ params: IdParamSchema, body: LinkConversationSchema }), ctrl.linkHandler);
conversationRouter.post('/:id/send-message', validate({ params: IdParamSchema, body: SendConvoMessageSchema }), ctrl.sendMessageHandler);
