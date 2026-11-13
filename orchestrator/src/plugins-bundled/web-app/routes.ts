/**
 * `POST /api/app/rearm` — starts the web app's supervisor again after it gave
 * up (TODO #485), without restarting the daemon and its live missions.
 *
 * Mounted by `@rooks/http`, not by `@rooks/web-app`: the route must answer
 * even when that module is off or returned early (app not built), to say why
 * there is nothing to rearm.
 *
 * Operator only: the daemon token, as `rooks app restart` and the desktop
 * shell send it. Never a browser session, never a mission token: relaunching
 * a process on the host is not a gesture a web page or an agent makes.
 */
import type { Router } from 'express';
import { rejectIfNotDaemonToken } from '../../users/identity.js';
import { wakeSupervisor, type WakeResult } from '../../kernel/child-supervisor.js';
import { appStatus, LABEL, type AppStatus } from './control.js';

export type RearmResponse = {
  ok: boolean;
  result: WakeResult;
  message: string;
};

const MESSAGES: Record<Exclude<WakeResult, 'unknown'>, string> = {
  running: 'The web app is already running; use `rooks app restart` to restart it.',
  starting: 'The web app is already starting.',
  woken: 'The web app supervisor was waiting; it retries now.',
  rearmed: 'The web app supervisor had given up; it starts the web app again.',
};

export function rearmResponse(result: WakeResult, status: () => AppStatus = appStatus): { code: number; body: RearmResponse } {
  if (result !== 'unknown') return { code: 200, body: { ok: true, result, message: MESSAGES[result] } };
  const st = status();
  // Disabled or not built: the status already says what to do. Otherwise the
  // daemon never supervised the app (built after its boot, config changed).
  const message = st.state === 'disabled' || st.state === 'not-built'
    ? st.message
    : 'This daemon does not supervise the web app (it was built or enabled after the daemon started); restart the Rooks service.';
  return { code: 409, body: { ok: false, result, message } };
}

export function registerRoutes(app: Router, wake: (label: string) => WakeResult = wakeSupervisor): void {
  app.post('/api/app/rearm', (req, res) => {
    if (rejectIfNotDaemonToken(req, res)) return;
    const { code, body } = rearmResponse(wake(LABEL));
    res.status(code).json(body);
  });
}
