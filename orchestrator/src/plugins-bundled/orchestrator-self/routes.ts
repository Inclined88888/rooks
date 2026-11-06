/**
 * Module `orchestrator-self` — the daemon driving itself (state, restart,
 * rebuild). Tier `opt`, requires `systemd`: without a service manager, these
 * routes have nothing to drive.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Router } from 'express';
import { getOrchestratorStatus, rebuildOrchestrator, restartOrchestrator } from '../../orchestrator-self.js';
import { rejectIfDenied, rejectUnlessAny } from '../../users/identity.js';

/**
 * Restarting takes every live mission with it, so it is `settings:write`, which
 * the mission token cap does not hold. Reading follows the card (TODO #645).
 * `control` is a parameter for the test: the real ones would stop the daemon.
 */
const READ_SELF = ['settings:write', 'widget:orchestrator-self', 'plugin:@timon/orchestrator-self'];

export function registerRoutes(
  app: Router,
  control: { restart: () => void; rebuild: () => void } = { restart: restartOrchestrator, rebuild: rebuildOrchestrator },
): void {
  app.get('/api/orchestrator/self', (req, res) => {
    if (rejectUnlessAny(req, res, READ_SELF)) return;
    try { res.json({ orchestrator: getOrchestratorStatus() }); }
    catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.post('/api/orchestrator/self/restart', (req, res) => {
    if (rejectIfDenied(req, res, 'settings:write')) return;
    // Answers BEFORE triggering the restart: the restart kills this process.
    res.json({ restarting: true });
    control.restart();
  });

  app.post('/api/orchestrator/self/rebuild', (req, res) => {
    if (rejectIfDenied(req, res, 'settings:write')) return;
    try {
      control.rebuild();
      res.json({ started: true });
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });
}
