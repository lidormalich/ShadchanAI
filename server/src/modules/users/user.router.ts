import { Router } from 'express';
import * as ctrl from './user.controller.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const userRouter = Router();
userRouter.use(requireAuth);

userRouter.get('/', ctrl.listHandler);
