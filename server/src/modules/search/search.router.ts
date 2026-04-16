import { Router } from 'express';
import * as ctrl from './search.controller.js';
import { SearchQuerySchema } from './search.validator.js';
import { validate } from '../../middleware/validate.middleware.js';
import { requireAuth } from '../../middleware/auth.middleware.js';

export const searchRouter = Router();
searchRouter.use(requireAuth);

searchRouter.get('/', validate({ query: SearchQuerySchema }), ctrl.searchHandler);
