/**
 * Module `@rooks/backends` — catalogue of the LLM backends.
 * Tier `core`: without a backend, no mission can be launched.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4). The Ollama Cloud proxy that used to sit here
 * had no caller and belonged to no provider: it went with the volet 5e migration.
 */
import type { Router } from 'express';
import { catalogFor } from './account-routes.js';

export function registerRoutes(app: Router): void {
  // Account instances are filtered by the caller's access list (TODO #52).
  app.get('/api/backends/catalog', (req, res) => {
    res.json(catalogFor(req));
  });
}
