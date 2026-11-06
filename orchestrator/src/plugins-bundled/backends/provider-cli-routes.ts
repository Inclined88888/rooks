/**
 * `/api/host/provider-clis` — the AI CLIs of the product's providers on this
 * machine: installed or not, signed in, which version, and their vendor's
 * official installer run as a job the screen follows (TODO #251, SUG-0005).
 *
 * Served to the onboarding's "Your AIs" step and to Settings › AI models ›
 * Providers alike. A browser session of a superadmin only, like the CLI
 * binaries next to it: installing a program on the machine is the machine
 * administrator's gesture, and neither the daemon token nor a mission token
 * may start one. The body never names a command: the path names a CLI from a
 * closed list, and the daemon derives what to run from its own table.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { recheckBinaries } from '../../backends/binary-pins.js';
import { installBackendPlanFor } from '../../host/machine.js';
import { PROVIDER_CLI_NAMES, providerClis, setupBackendsNow } from '../../onboarding.js';
import { cliInstallJob, startCliInstall, type InstallDeps } from '../../provider-cli-install.js';
import { config } from '../../config/load.js';
import { whichBin } from '../../doctor.js';
import { ensureCliVersionsChecked, installedBeyondSupportedMajor, refreshCliVersions } from '../../provider-cli-versions.js';
import { settingBool } from '../../settings.js';
import { auditRequest } from '../../users/audit-actor.js';
import { requireSessionSuperadmin } from './binary-routes.js';

const NameParam = z.enum(PROVIDER_CLI_NAMES as [string, ...string[]]);

/** What a successful install changes: the CLIs are looked for again, its version read. */
async function afterInstall(name: string): Promise<void> {
  await recheckBinaries();
  await refreshCliVersions([name]);
}

function cliName(req: Request, res: Response): string | null {
  const parsed = NameParam.safeParse(req.params.name);
  // zod's issues would quote the input: a fixed message instead.
  if (!parsed.success) { res.status(400).json({ error: 'unknown_cli' }); return null; }
  return parsed.data;
}

async function list(res: Response): Promise<void> {
  try {
    const backends = await setupBackendsNow();
    const jobs = Object.fromEntries(backends.flatMap((backend) => {
      const job = cliInstallJob(backend.name);
      return job ? [[backend.name, job]] : [];
    }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ backends, jobs, updateCheck: settingBool('TIMON_CLI_UPDATE_CHECK') });
  } catch (error) {
    console.warn(`[provider-cli] could not list the AI CLIs: ${(error as Error).message}`);
    res.status(500).json({ error: 'backends_unavailable' });
  }
}

type RouteDeps = InstallDeps & {
  /** Reads the version of the binary at this exact path (the guard against another generation). */
  readVersion?: (path: string) => Promise<string | null>;
};

export function registerProviderCliRoutes(router: Router, deps: RouteDeps = {}): void {
  const { readVersion, ...installDeps } = deps;
  const locate = deps.locate ?? ((name: string) => whichBin(name, config().host.binaries).path);
  router.get('/api/host/provider-clis', async (req, res) => {
    if (!requireSessionSuperadmin(req, res)) return;
    // Never waits for the vendors: the first read of a fresh daemon starts the check and answers.
    ensureCliVersionsChecked();
    await list(res);
  });

  // "Check for updates": the versions are read again before answering, each
  // vendor bounded by its own timeout.
  router.post('/api/host/provider-clis/check', async (req, res) => {
    if (!requireSessionSuperadmin(req, res)) return;
    await refreshCliVersions().catch((error: Error) => console.warn(`[provider-cli] version check: ${error.message}`));
    await list(res);
  });

  router.post('/api/host/provider-clis/:name/install', async (req, res) => {
    if (!requireSessionSuperadmin(req, res)) return;
    const name = cliName(req, res);
    if (!name) return;
    const declared = providerClis().find((cli) => cli.name === name);
    // No installer at all, or none for this OS (opencode on Windows): the card links to the vendor's page.
    if (!declared?.installer || !installBackendPlanFor(name, deps.platform ?? process.platform)) {
      res.status(409).json({ error: 'no_installer' });
      return;
    }
    // Hidden on the card, refused here too: a request typed by hand must not overwrite a newer
    // generation of the binary with the one the product supports.
    const path = cliInstallJob(name)?.state === 'running' ? null : locate(name);
    if (path && await installedBeyondSupportedMajor(name, path, readVersion)) {
      res.status(409).json({ error: 'unsupported_version' });
      return;
    }
    auditRequest(req, 'backends.cli.install', name);
    res.status(202).json({ job: startCliInstall(name, { afterSuccess: afterInstall, ...installDeps }) });
  });

  router.get('/api/host/provider-clis/:name/install', (req, res) => {
    if (!requireSessionSuperadmin(req, res)) return;
    const name = cliName(req, res);
    if (!name) return;
    const job = cliInstallJob(name);
    if (!job) { res.status(404).json({ error: 'no_job' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ job });
  });
}
