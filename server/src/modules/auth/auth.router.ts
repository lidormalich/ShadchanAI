import { Router } from 'express';
import * as ctrl from './auth.controller.js';
import { LoginSchema, RegisterSchema, ChangePasswordSchema } from './auth.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { authRateLimiter } from '../../middleware/rateLimiter.middleware.js';

export const authRouter = Router();

// Public routes — rate-limited
authRouter.post('/login', authRateLimiter, validate({ body: LoginSchema }), ctrl.loginHandler);
authRouter.post('/bootstrap', authRateLimiter, validate({ body: RegisterSchema }), ctrl.bootstrapHandler);

// Authenticated routes
authRouter.get('/me', requireAuth, ctrl.meHandler);
authRouter.post('/register', requireAuth, validate({ body: RegisterSchema }), ctrl.registerHandler);
authRouter.post('/change-password', requireAuth, validate({ body: ChangePasswordSchema }), ctrl.changePasswordHandler);
