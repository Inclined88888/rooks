/**
 * The window's Content-Security-Policy, wired into the app's HTTP server
 * (`server.ts`): every response carries it, documents and API alike, so a
 * same-origin URL started as a worker or framed is held to the same egress as
 * the page (`lib/content-security-policy.ts`).
 *
 * The declared hosts come from the LOCAL daemon's `/api/plugins`, read with
 * the daemon token: a browser half always loads from this computer's copy,
 * a remote machine's plugin included (`plugin-host/remote-plugins.ts`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  contentSecurityPolicy,
  createEgressSource,
  enforceContentSecurityPolicy,
  wantsFreshPolicy,
  type EgressSource,
} from '../content-security-policy';
import { localTarget } from '../machines/target';
import { orchestratorAuthHeaders } from '../orchestrator';

const LOAD_TIMEOUT_MS = 1_500;

async function loadDaemonPlugins(): Promise<unknown> {
  const res = await fetch(`${localTarget().url}/api/plugins`, {
    headers: orchestratorAuthHeaders(),
    signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function createWindowPolicy(opts: { dev: boolean; source?: EgressSource }): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let warned = false;
  const source = opts.source ?? createEgressSource({
    load: loadDaemonPlugins,
    onError: (error) => {
      if (warned) return;
      warned = true;
      console.warn(`[timon-app] plugin egress hosts unavailable, window held to its own origin: ${(error as Error).message}`);
    },
  });
  return async (req, res) => {
    if (wantsFreshPolicy(req.method, req.headers)) await source.refresh();
    const host = typeof req.headers.host === 'string' ? req.headers.host : null;
    enforceContentSecurityPolicy(res, contentSecurityPolicy({ egressHosts: source.hosts(), dev: opts.dev, selfHost: host }));
  };
}
