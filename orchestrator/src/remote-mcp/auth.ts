/**
 * Authentication of the remote MCP endpoint. Called by the daemon's auth
 * middleware (`plugins-bundled/http/auth.ts`) BEFORE any other credential is
 * looked at, so this path accepts a remote MCP token and nothing else:
 *  - not the daemon-token: it is the operator's superadmin credential, and the
 *    operator's own agents use the stdio server; letting it through here would
 *    turn a tunnelled endpoint into a superadmin door;
 *  - not a mission `api_tokens` row nor a session cookie: those open the REST
 *    API, this endpoint is reserved to the narrower grant.
 * The token is read from `Authorization: Bearer` only, never the query string.
 */
import type { Request, Response } from 'express';
import { verifyRemoteMcpToken, type RemoteMcpGrant } from './tokens.js';

export const REMOTE_MCP_PATH = '/api/remote-mcp';

// Express matches routes case-insensitively and ignores a trailing slash: the
// gate must catch every spelling the route would answer.
const REMOTE_MCP_PATH_RE = /^\/api\/remote-mcp\/?$/i;

const grants = new WeakMap<Request, RemoteMcpGrant>();

export function isRemoteMcpPath(path: string): boolean {
  return REMOTE_MCP_PATH_RE.test(path);
}

/** The grant the middleware attached to this request, if any. */
export function remoteMcpGrant(req: Request): RemoteMcpGrant | undefined {
  return grants.get(req);
}

export function refuseRemoteMcp(res: Response): void {
  res.status(401).set('WWW-Authenticate', 'Bearer realm="timon-mcp"').json({ error: 'unauthorized' });
}

/** `true` with the grant attached, or `false` after answering 401. */
export function authenticateRemoteMcp(req: Request, res: Response): boolean {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  const grant = match?.[1] ? verifyRemoteMcpToken(match[1]) : undefined;
  if (!grant) {
    refuseRemoteMcp(res);
    return false;
  }
  grants.set(req, grant);
  return true;
}
