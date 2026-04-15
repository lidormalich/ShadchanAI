import { Router } from 'express';
import * as ctrl from './note.controller.js';
import {
  CreateNoteSchema,
  UpdateNoteSchema,
  ListNotesQuerySchema,
  IdParamSchema,
} from './note.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const noteRouter = Router();
noteRouter.use(requireAuth);

noteRouter.get('/', validate({ query: ListNotesQuerySchema }), ctrl.listHandler);
noteRouter.post('/', validate({ body: CreateNoteSchema }), ctrl.createHandler);
noteRouter.patch('/:id', validate({ params: IdParamSchema, body: UpdateNoteSchema }), ctrl.updateHandler);
noteRouter.delete('/:id', validate({ params: IdParamSchema }), ctrl.deleteHandler);
