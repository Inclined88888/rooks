import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { buildInfo } from '../build-info.js';
import { licenseState, reevaluateBuildPolicy } from './runtime.js';

/**
 * HTTP half of the beta lock (`build-policy.ts` is the state half).
 *
 * The locked state already switches the paid modules off and refuses agent
 * turns, but three things escape it: core-tier routes, which no module guard
 * covers; `@rooks/users` and `@rooks/web-app`, exempted on purpose so accounts
 * stay reachable; and the endpoints that need no identity at all (inbound
 * integrations, workflow hooks), which start work on their own. So on a beta
 * build that is not `valid`, this is a default-DENY wall: only the listed
 * endpoints answer, and it applies to the daemon-token and to superadmins as
 * much as to anyone else.
 *
 * Mounted right after the authentication middleware: an anonymous caller is
 * refused there (401) before the wall even speaks, and an identified one is
 * refused here (403) on everything that is not licence, health, auth, the data
 * export or the update offer.
 *
 * `dev` and `stable` builds pass straight through: no state is read.
 */
const ALLOWED: readonly { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/api\/health$/ },
  // What the login and setup screens need, and nothing else under /api/auth.
  { method: 'GET', path: /^\/api\/auth\/me$/ },
  { method: 'POST', path: /^\/api\/auth\/setup$/ },
  { method: 'POST', path: /^\/api\/auth\/login$/ },
  { method: 'POST', path: /^\/api\/auth\/logout$/ },
  { method: 'POST', path: /^\/api\/auth\/email\/confirm$/ },
  // Taking one's data out must survive the end of the beta. The route itself
  // refuses a caller-chosen `out` on a locked build, so it cannot write
  // anywhere but its own archive name under the home.
  { method: 'POST', path: /^\/api\/admin\/export$/ },
  // The way out: read the state, enter a key, release the machine.
  { method: 'GET', path: /^\/api\/license$/ },
  { method: 'PUT', path: /^\/api\/license$/ },
  { method: 'POST', path: /^\/api\/license\/(activate|deactivate|name)$/ },
  // The way out of an ended build: a public, signed offer of a newer version.
  // The routes keep their own auth and permissions (`settings`,
  // `settings:write`), so an anonymous caller is still refused upstream.
  { method: 'GET', path: /^\/api\/updates$/ },
  { method: 'POST', path: /^\/api\/updates\/check$/ },
  // The desktop counts the missions an update would stop before it installs.
  { method: 'GET', path: /^\/api\/updates\/missions$/ },
];

export function betaGateAllows(method: string, path: string): boolean {
  return ALLOWED.some((entry) => entry.method === method && entry.path.test(path));
}

export function createBetaGate(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const info = buildInfo();
    if (info.channel !== 'beta') { next(); return; }
    // The end date may pass between two local ticks: judge it on this request.
    if (info.expiresAtMs !== null && Date.now() >= info.expiresAtMs) reevaluateBuildPolicy();
    const state = licenseState();
    // Local Free is not a lock: under the `free` setup policy a beta build
    // without a licence runs on it (`build-policy.ts`).
    if (state.status === 'valid' || state.localFree === true || betaGateAllows(req.method, req.path)) { next(); return; }
    res.status(403).json({ error: 'license_required', reason: state.reason });
  };
}
