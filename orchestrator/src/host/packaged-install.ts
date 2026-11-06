/**
 * The install sequence shared by the onboarding button and
 * `timon service install`. A packaged service on macOS and Linux runs from a
 * copy under `desktop-runtime/releases`: installing its unit without staging
 * that copy first registers a binary that does not exist.
 * No database import here: the CLI loads this module too.
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordReleaseSource } from './packaged-handback.js';
import {
  markActiveRelease,
  pruneInactiveReleases,
  readActiveRelease,
  recordHandover,
  runtimeDir,
  stagePackagedRuntime,
} from './packaged-service.js';
import { stagesPackagedRuntime } from './service-environment.js';
import type { ServiceOpts } from './service-install.js';

/**
 * `sourceInstallDir` is the orchestrator of the running package
 * (`config.daemon.installDir`), not `opts.installDir`, which already names the
 * staged copy.
 */
export async function installWithRuntime<R extends { ok: boolean }>(
  opts: ServiceOpts,
  sourceInstallDir: string,
  install: (o: ServiceOpts) => R,
): Promise<R> {
  const packaged = stagesPackagedRuntime(opts.platform, process.env);
  if (packaged) {
    await stagePackagedRuntime(opts.timonHome, process.execPath, sourceInstallDir);
    if (opts.platform === 'linux' && process.env.TIMON_DESKTOP_EMBEDDED === '1') {
      await recordHandover(opts.timonHome, process.pid);
    }
  }
  const previousRelease = packaged ? await readActiveRelease(opts.timonHome) : null;
  const result = install(opts);
  if (result.ok && opts.unitName) {
    await writeFile(join(runtimeDir(opts.timonHome), 'installed'), opts.unitName, { mode: 0o600 });
  }
  if (result.ok && packaged) {
    await markActiveRelease(opts.timonHome);
    if (opts.platform === 'linux') {
      try {
        recordReleaseSource(opts.timonHome, process.execPath);
      } catch (error) {
        console.warn('[desktop-runtime] could not record where this release was installed', error);
      }
    }
    // Cleanup is deliberately best-effort: a permission error must not turn
    // a successfully migrated daemon into a failed application startup.
    await pruneInactiveReleases(opts.timonHome, undefined, previousRelease ? [previousRelease] : []).catch((error: unknown) => {
      console.warn('[desktop-runtime] could not remove an inactive release', error);
    });
  }
  return result;
}

/**
 * The desktop reads `installed` to wait for a Linux service instead of
 * starting its own daemon (`desktop/src/service.ts`): removing the unit
 * without it would leave the app waiting for a service that is gone.
 */
export async function uninstallWithRuntime<R extends { ok: boolean }>(
  opts: ServiceOpts,
  uninstall: (o: ServiceOpts) => R,
): Promise<R> {
  const result = uninstall(opts);
  if (result.ok && opts.unitName && !opts.dryRun) {
    await rm(join(runtimeDir(opts.timonHome), 'installed'), { force: true });
  }
  return result;
}
