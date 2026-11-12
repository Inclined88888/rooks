/**
 * Module `terminal-native` — opening the host machine's terminal and
 * revealing a folder in the file manager. Tier `opt`, requires the `gui`
 * capability: without a graphical session, there is nothing to open.
 * No web shell, by choice (see `terminal.ts`).
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Router } from 'express';
import { RevealUnavailableError, revealAgentPath } from '../../files.js';
import {
  hostHasGui,
  isKnownCwd,
  isTerminalEnabled,
  openTerminal,
  terminalCommand,
  terminalStatus,
} from '../../terminal.js';
import { apiError } from '../../api-error.js';

export function registerRoutes(app: Router): void {
  app.post('/api/agents/:name/files/reveal', async (req, res) => {
    // `client: 'desktop'` is the Electron app saying it can show the path on
    // the user's desktop itself when this daemon has no session to do it in.
    const body = (req.body ?? {}) as { path?: unknown; client?: unknown };
    const rel = typeof body.path === 'string' ? body.path : '';
    try {
      res.json(await revealAgentPath(req.params.name, rel, { clientCanOpen: body.client === 'desktop' }));
    } catch (err) {
      if (err instanceof RevealUnavailableError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/terminal', (_req, res) => {
    res.json(terminalStatus());
  });

  app.post('/api/terminal/open', (req, res) => {
    // 501, not 500: this host does not implement a desktop terminal.
    // 409 would imply a temporary conflict; retrying will not grow a `gui`.
    if (!hostHasGui()) {
      res.status(501).json({ ok: false, error: 'host has no gui capability', reason: 'no_gui' });
      return;
    }
    if (!isTerminalEnabled()) {
      res.status(403).json({ error: 'terminal opening is disabled (ROOKS_TERMINAL_ENABLED)' });
      return;
    }
    const cwd = (req.body ?? {}).cwd;
    if (typeof cwd !== 'string' || !cwd.trim()) {
      res.status(400).json({ error: 'cwd is required' });
      return;
    }
    // The path comes from the client: only open what Rooks already knows.
    if (!isKnownCwd(cwd)) {
      res.status(400).json(apiError('path_unknown', 'path unknown to Rooks (neither an agent cwd nor a task worktree)'));
      return;
    }
    const out = openTerminal(cwd);
    if (!out.ok) { res.status(500).json(out); return; }
    // Immediate reply: the process hands off to the existing instance and
    // exits, so waiting on its status would not prove the window opened.
    res.json({ ok: true, cwd, command: terminalCommand() });
  });
}
