/**
 * Module `video-factory` — video factory progress.
 * Tier `opt`: side project, absent from most installations.
 *
 * Route extracted verbatim from `index.ts` (step 1.4).
 */
import type { Router } from 'express';
import { rejectUnlessAny } from '../../users/identity.js';
import { readVideoFactoryProgress } from '../../video-factory.js';

export function registerRoutes(app: Router): void {
  app.get('/api/video-factory/progress', (req, res) => {
    if (rejectUnlessAny(req, res, ['projects:manage', 'widget:video-factory', 'plugin:@rooks/video-factory'])) return;
    res.json(readVideoFactoryProgress());
  });
}
