/**
 * The remote MCP endpoint, Streamable HTTP transport (MCP 2025-03-26 and
 * 2025-06-18): one POST per JSON-RPC message (or batch), answered with
 * `application/json`. Stateless — no `Mcp-Session-Id`, no server-initiated
 * stream: GET and DELETE answer 405, which the transport allows.
 *
 * It listens wherever the daemon listens (loopback by default); reaching it
 * from another machine is the operator's choice of tunnel (`docs/SECURITY.md`).
 */
import type { Request, Response, Router } from 'express';
import { REMOTE_MCP_PATH, refuseRemoteMcp, remoteMcpGrant } from './auth.js';
import {
  handleRemoteMcpMessage, INVALID_REQUEST, isSupportedProtocolVersion, PARSE_ERROR, type JsonRpcResponse,
} from './server.js';

/**
 * A browser page elsewhere must not drive the endpoint through a user's
 * tunnel (DNS rebinding, which the MCP transport asks servers to guard
 * against). Agents send no `Origin`; a browser on the same host does.
 */
function crossOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).set('Allow', 'POST').json({ error: 'method not allowed' });
}

export function registerRemoteMcpRoutes(app: Router): void {
  app.post(REMOTE_MCP_PATH, async (req, res) => {
    // The auth middleware attached it; without it nothing here runs, whatever
    // other credential the request carried.
    const grant = remoteMcpGrant(req);
    if (!grant) { refuseRemoteMcp(res); return; }
    if (crossOrigin(req)) { res.status(403).json({ error: 'cross-origin request refused' }); return; }
    const version = req.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !isSupportedProtocolVersion(version)) {
      res.status(400).json({ error: `unsupported MCP protocol version ${version}` });
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'expected application/json' } });
      return;
    }
    const body: unknown = req.body;
    const batch = Array.isArray(body);
    const messages: unknown[] = batch ? body : [body];
    if (messages.length === 0) {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'empty batch' } });
      return;
    }
    try {
      const answers: JsonRpcResponse[] = [];
      for (const msg of messages) {
        const answer = await handleRemoteMcpMessage(msg, grant);
        if (answer) answers.push(answer);
      }
      if (answers.length === 0) { res.status(202).end(); return; }
      res.json(batch ? answers : answers[0]);
    } catch (err) {
      console.warn(`[remote-mcp] request failed for mission ${grant.missionId.slice(0, 8)}: ${(err as Error).message}`);
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } });
    }
  });
  app.get(REMOTE_MCP_PATH, methodNotAllowed);
  app.delete(REMOTE_MCP_PATH, methodNotAllowed);
}
