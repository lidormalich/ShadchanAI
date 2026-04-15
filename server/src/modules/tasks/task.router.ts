import { Router } from 'express';
import * as ctrl from './task.controller.js';
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  CompleteTaskSchema,
  ReassignTaskSchema,
  ListTasksQuerySchema,
  IdParamSchema,
} from './task.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const taskRouter = Router();
taskRouter.use(requireAuth);

taskRouter.get('/', validate({ query: ListTasksQuerySchema }), ctrl.listHandler);
taskRouter.get('/:id', validate({ params: IdParamSchema }), ctrl.getHandler);
taskRouter.post('/', validate({ body: CreateTaskSchema }), ctrl.createHandler);
taskRouter.patch('/:id', validate({ params: IdParamSchema, body: UpdateTaskSchema }), ctrl.updateHandler);
taskRouter.post('/:id/complete', validate({ params: IdParamSchema, body: CompleteTaskSchema }), ctrl.completeHandler);
taskRouter.post('/:id/reassign', validate({ params: IdParamSchema, body: ReassignTaskSchema }), ctrl.reassignHandler);
