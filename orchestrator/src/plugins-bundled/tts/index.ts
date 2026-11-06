/**
 * Module `tts` — in-app voice (piper), and above all: WHICH URL the app
 * must call to get it.
 *
 * Three setups, in the precedence order of plan §4.3.4:
 *
 *  1. `TIMON_TTS_URL` non-empty → an external TTS service already exists,
 *     hand it off to that. No child, no container.
 *  2. Otherwise, `containers` capability AND a `docker-compose.yml` next to
 *     the install → the compose `tts` container (`docker` profile) is started
 *     on demand, and the app points at the loopback. Docker being installed on
 *     the machine is NOT enough: the stack itself only exists in the
 *     development repository. A packaged client resolves `installDir` to
 *     `resources/orchestrator`, where no compose file has ever been shipped —
 *     concluding `container` there made every first launch on a machine with
 *     Docker print `open …/resources/docker-compose.yml: no such file` and
 *     advise a `docker compose build` that means nothing to an end user.
 *  3. Otherwise → module disabled: no voice, and the app will know because
 *     it won't receive a `TTS_URL`.
 *
 * This module supervises no process: piper is either remote, or in a
 * container that has its own `restart: unless-stopped`.
 *
 * Note for the next reader: when the module is disabled while `web-app` is
 * running, the app receives a URL that doesn't respond. This isn't an
 * oversight — it's exactly what Compose does today, where the app carries
 * `http://tts:5000` whether the container is up or not. Making the app's env
 * depend on ANOTHER module's state would be coupling for nothing.
 */
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Host } from '../../host/index.js';
import type { ModuleManifest } from '../../kernel/registry.js';
import type { TimonConfig } from '../../config/schema.js';
import { config } from '../../config/load.js';
import { settingStr } from '../../settings.js';

export const manifest: ModuleManifest = {
  name: '@timon/tts',
  tier: 'opt',
  inject: ['host'],
};

export const name = manifest.name;
export const inject = manifest.inject;

/** Port of the `tts` container, published on the loopback by Compose. */
export const LOCAL_TTS_URL = 'http://127.0.0.1:5000';

export type TtsSource = 'external' | 'container' | 'none';
export type TtsResolution = { source: TtsSource; url: string | null };

/**
 * Which TTS URL the app must call.
 *
 * PURE function, exported so `web-app` can read it while composing the
 * child's environment: a Cordis service would make `tts` a HARD dependency
 * of `web-app` (Cordis 4 has no optional `inject`), and mutating
 * `process.env` would make the result depend on module mount order.
 *
 * `TIMON_TTS_URL` is read via `settingStr`, not `process.env`: it's a key of
 * the `settings.ts` registry, hence settable from the UI. Reading it the
 * other way would silently ignore a value the user set.
 */
export function resolveTts(hasContainers: boolean, hasComposeStack: boolean): TtsResolution {
  const external = settingStr('TIMON_TTS_URL').trim();
  if (external) return { source: 'external', url: external };
  // Both, not either: a Docker on the machine says nothing about whether THIS
  // installation carries the stack that defines the `tts` service.
  if (hasContainers && hasComposeStack) return { source: 'container', url: LOCAL_TTS_URL };
  return { source: 'none', url: null };
}

/** Repo root, where Compose is read from (`<installDir>/..`), like
 *  `appDirOf` for the app. */
export function repoRootOf(cfg: TimonConfig): string {
  return resolve(cfg.daemon.installDir, '..');
}

/** The Compose file the `tts` service is defined in. */
export function composeFileOf(repoRoot: string): string {
  return resolve(repoRoot, 'docker-compose.yml');
}

/**
 * Does THIS installation carry the Compose stack?
 *
 * The only impure part of the module's decision, kept OUT of `resolveTts` so
 * that function stays pure and callable from `web-app` (see above). A
 * development checkout answers yes; a packaged client answers no, and nothing
 * is broken by that — it simply has no container to offer.
 */
export function composeStackAvailable(cfg: TimonConfig): boolean {
  return existsSync(composeFileOf(repoRootOf(cfg)));
}

/**
 * Compose project name. Reproduces Compose's own rule (normalized basename
 * of the file's folder): deriving it instead of hardcoding it avoids
 * creating a SECOND stack alongside the one already running.
 */
export function composeProjectOf(repoRoot: string): string {
  return basename(repoRoot).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/**
 * `docker compose --profile docker up -d --no-build tts`, with explicit
 * `-f` and `-p`: without them, the command would run against the daemon's
 * cwd, which isn't necessarily the repo.
 *
 * `--no-build` isn't a stylistic precaution. The `tts` service has a
 * `build:` and the project name is derived from the folder: on a repo whose
 * image was never built, `up -d` would build — several minutes of docker
 * build triggered at daemon startup that nobody asked for. Without an
 * image, the command fails in one second and the log says what to do.
 */
export function composeArgs(repoRoot: string): string[] {
  return [
    'compose',
    '-f', composeFileOf(repoRoot),
    '-p', composeProjectOf(repoRoot),
    '--profile', 'docker',
    'up', '-d', '--no-build', 'tts',
  ];
}

/**
 * Starts the `tts` container, WITHOUT blocking boot.
 *
 * `host.containers.cli` is synchronous (the `exec` family, not `execAsync`):
 * calling it from `apply` would freeze the event loop — hence the whole
 * daemon, and `app.listen` with it — while docker responds. So we go
 * through `host.spawn`, like the other three phase-3 modules, and read the
 * result in the exit listener.
 */
export function startContainer(host: Host, cfg: TimonConfig): () => void {
  const args = composeArgs(repoRootOf(cfg));
  const child = host.spawn('docker', args, { stdio: 'inherit' });
  // No throw, no restart: a missing voice doesn't take the daemon down,
  // and a failing `up -d` would fail the same way on a second try.
  child.on('error', (err: Error) => {
    console.error(`[tts] container startup failed: ${err.message}`);
  });
  child.on('exit', (code) => {
    if (code === 0) console.log(`[tts] container started — the app points at ${LOCAL_TTS_URL}`);
    else console.error(`[tts] container startup failed (code ${code ?? 'null'}) — missing image? \`docker compose --profile docker build tts\``);
  });
  return () => { if (child.pid !== undefined) child.kill(); };
}

export function apply(ctx: Context): void {
  const cfg = config();
  const host = ctx.host as Host;
  const resolution = resolveTts(Boolean(host.containers), composeStackAvailable(cfg));

  if (resolution.source === 'external') {
    console.log(`[tts] external service (TIMON_TTS_URL) — nothing to start: ${resolution.url}`);
    return;
  }
  if (resolution.source === 'none') {
    // Informative, never an error: nothing failed. The packaged case is the
    // common one, and telling a user to build an image they do not have is
    // worse than saying nothing.
    console.log(host.containers
      ? `[tts] disabled: no ${composeFileOf(repoRootOf(cfg))} in this installation — set TIMON_TTS_URL to enable voice`
      : '[tts] disabled: neither TIMON_TTS_URL nor `containers` capability');
    return;
  }
  ctx.effect(() => startContainer(host, cfg));
}
