/**
 * Who may CHANGE the backends of this install, past the superadmin check of
 * `/api/backends/custom` and `/api/backends/manage` (TODO #571).
 *
 * A human only: a session in the app, a paired device, or the operator's
 * terminal (`timon backend …` with the daemon-token). Never an agent, even one
 * launched by a developer account whose token is superadmin: a profile decides
 * where the prompts of every mission go and which program runs them, so a
 * mission that could add one would choose the provider of the missions after
 * it, and one that could remove one would take the others' down. The maintainer's default
 * of 30/10/2026 — no `backends:manage` permission for agents.
 *
 * Reads stay open to whoever the prefix lets in (the listing carries no key).
 * Every other verb is gated, testing included: an ad-hoc test makes the daemon
 * call an address of the caller's choosing.
 */
import type { Request, Response } from 'express';
import { forbidden } from '../../users/identity.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The daemon-token cannot prove who holds it. Inside a mission, the CLI and
 * the MCP server send `X-TIMON-Mission` with it — before first-run setup it is
 * the only credential a mission holds. That claim can only restrict the
 * operator, never widen, so it is taken at its word.
 */
function agentCaller(req: Request): boolean {
  const auth = req.auth;
  if (!auth) return false;
  if (auth.kind === 'api-token') return true;
  return auth.kind === 'daemon-token' && !!req.header('X-TIMON-Mission');
}

/**
 * Sends the refusal and returns true when the request may not change a
 * backend. Two refusals, both before any route reads the body:
 *  - an agent's credential (403, audited as `authz.denied`);
 *  - any query string on a change (400): the key is accepted in the body only,
 *    since a URL lands in access logs, a shell history and a `Referer`. The
 *    query is refused whole and never echoed.
 */
export function refuseBackendChange(req: Request, res: Response): boolean {
  if (READS.has(req.method.toUpperCase())) return false;
  if (agentCaller(req)) {
    return forbidden(req, res, {
      kind: 'operator',
      reason: 'backends are added, tested and removed by a person, never by an agent',
      hint: 'Ask the user to do it in Settings → Backends, or with `timon backend` from a terminal outside any mission.',
    });
  }
  if (req.originalUrl.includes('?')) {
    res.status(400).json({ error: 'query parameters are not accepted here: send every field, the key included, in the JSON body', code: 'query-refused' });
    return true;
  }
  return false;
}
