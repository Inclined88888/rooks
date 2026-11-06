/**
 * The provider plugins' own screen (`/api/plugins/-/providers`):
 *
 *   GET  /api/plugins/-/providers                 installed providers, their binaries as THIS host resolves them
 *   POST /api/plugins/-/providers/:id/authorize   { paths } → the superadmin accepts the resolved paths
 *
 * Same door as the gallery's install flow, and for the same reason: accepting a
 * binary lets an in-process plugin run it on the operator's machine. A
 * superadmin SIGNED IN TO THE APP, nobody else — not the daemon token, not a
 * mission token (an agent must never widen the allowlist it is bound by).
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { clearLaunchCard } from '../../backends/launch-card.js';
import { registeredBackendOwners } from '../../backends/registry.js';
import { ExecGrantError, grantProviderBinaries, providerBinaryRequests } from '../../plugins/exec-grants.js';
import { loaderFromApp } from '../../plugins/runtime.js';
import { requireAppSuperadmin } from './install-routes.js';

const PREFIX = '/api/plugins/-/providers';
const idSchema = z.string().regex(/^[a-z0-9-]{3,40}$/);
const authorizeSchema = z.object({ paths: z.array(z.string().min(1).max(4096)).max(8) }).strict();

function loaderOf(req: Request) {
  return loaderFromApp(req.app);
}

function providerStatuses(req: Request) {
  const owners = registeredBackendOwners().profiles;
  return (loaderOf(req)?.list() ?? [])
    .filter((status) => status.manifest?.kind.includes('provider'))
    .map((status) => ({
      id: status.id,
      label: status.manifest?.label ?? status.id,
      version: status.version,
      state: status.state,
      reason: status.reason,
      error: status.error,
      signed: status.signed,
      binaries: status.manifest ? providerBinaryRequests(status.manifest) : [],
      osCredentials: [...(status.manifest?.provider?.osCredentials ?? [])],
      credentialDirs: [...(status.manifest?.provider?.credentialDirs ?? [])],
      backends: Object.entries(owners).filter(([, owner]) => owner === status.id).map(([backend]) => backend),
    }));
}

export function registerProviderRoutes(router: Router): void {
  router.get(PREFIX, (req: Request, res: Response) => {
    if (!requireAppSuperadmin(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ providers: providerStatuses(req) });
  });

  router.post(`${PREFIX}/:id/authorize`, async (req: Request, res: Response) => {
    if (!requireAppSuperadmin(req, res)) return;
    const id = idSchema.safeParse(req.params.id);
    const body = authorizeSchema.safeParse(req.body ?? {});
    if (!id.success || !body.success) {
      return void res.status(400).json({ error: 'invalid-body', message: 'expected `{ paths: string[] }`' });
    }
    const loader = loaderOf(req);
    const status = loader?.list().find((entry) => entry.id === id.data);
    if (!loader || !status?.manifest?.kind.includes('provider')) {
      return void res.status(404).json({ error: 'not-found', message: 'no such provider plugin' });
    }
    try {
      const { granted } = await grantProviderBinaries(status.manifest, body.data.paths);
      // The card a refused launch raised (TODO #598) is answered: the next launch is checked against this.
      clearLaunchCard(id.data, { force: true });
      // A provider that failed on the allowlist mounts now, with no restart.
      await loader.update();
      res.json({ granted, providers: providerStatuses(req).filter((p) => p.id === id.data) });
    } catch (err) {
      if (err instanceof ExecGrantError) return void res.status(err.status).json({ error: err.code, message: err.message });
      console.warn(`[plugins] provider authorization: ${(err as Error).message}`);
      res.status(500).json({ error: 'authorize-failed', message: 'the binary could not be authorized — the daemon log has the details' });
    }
  });
}
