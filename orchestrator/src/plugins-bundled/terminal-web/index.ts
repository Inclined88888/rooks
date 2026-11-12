/**
 * Module `terminal-web` — a real terminal emulator in the UI (desktop, web,
 * phone PWA), backed by a pseudo-terminal on the host. Tier `opt`, no host
 * capability required: unlike `terminal-native`, it needs no graphical
 * session, so it works on a headless server reached from a phone.
 *
 * Access rules: `access.ts`. Sessions survive their clients
 * (`terminal-host/sessions.ts`) and, through the terminal host, a daemon
 * restart (`hosted.ts`).
 */
import { homedir } from 'node:os';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { novaVersion } from '../../data-version.js';
import type { Host } from '../../host/index.js';
import type { ModuleManifest } from '../../kernel/registry.js';
import { ROOKS_HOME } from '../../paths.js';
import { settingInt } from '../../settings.js';
import { hostFiles, type HostFiles } from '../../terminal-host/protocol.js';
import { nodePtySpawner } from '../../terminal-host/pty.js';
import { TerminalSessions } from '../../terminal-host/sessions.js';
import { HostedSessions } from './hosted.js';
import { createUpgradeHandler, registerRoutes } from './routes.js';
import { localStore, type SessionStore } from './store.js';

export const manifest: ModuleManifest = {
  name: '@rooks/terminal-web',
  tier: 'opt',
  inject: ['http', 'db', 'host'],
};

export const name = manifest.name;
export const inject = manifest.inject;

/** The host entry of this build: `.js` once compiled, `.ts` under tsx. */
export function hostEntry(): string {
  const ext = extname(fileURLToPath(import.meta.url));
  return fileURLToPath(new URL(`../../terminal-host/main${ext}`, import.meta.url));
}

/**
 * The host runs on the daemon's own runtime — never a `node` from PATH, whose
 * ABI may not match node-pty's binary. Its environment is the daemon's minus
 * every `ROOKS_*` key (the daemon token among them), plus the home it serves.
 */
export function hostEnv(source: NodeJS.ProcessEnv = process.env, electron: string | undefined = process.versions.electron): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !key.startsWith('ROOKS_')) env[key] = value;
  }
  env.ROOKS_HOME = ROOKS_HOME;
  if (electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

async function launchHost(host: Host, files: HostFiles): Promise<{ via: string }> {
  const entry = hostEntry();
  const started = await host.spawnDetached!({
    name: 'rooks-terminal-host',
    cmd: process.execPath,
    // Under tsx (development) the loader flags come along; a build has none to pass.
    args: [...(entry.endsWith('.ts') ? process.execArgv : []), entry],
    env: hostEnv(),
    cwd: homedir(),
    logFile: files.log,
  });
  console.log(`[terminal-web] terminal host started (${started.via}, pid ${started.pid ?? 'unknown'})`);
  return { via: started.via };
}

export function apply(ctx: Context): void {
  const idleMs = (): number => Math.max(1, settingInt('ROOKS_TERMINAL_WEB_IDLE_MIN')) * 60_000;
  const local = (): TerminalSessions => new TerminalSessions({ spawn: nodePtySpawner, idleMs });
  const host = ctx.host as Host;
  let sessions: SessionStore;
  if (host.spawnDetached) {
    const files = hostFiles(ROOKS_HOME);
    const hosted = new HostedSessions({
      endpoint: files.endpoint,
      tokenFile: files.token,
      build: novaVersion(),
      idleMs,
      local,
      launch: () => launchHost(host, files),
    });
    // Shells a previous daemon left in the host come back with it.
    void hosted.reconnect().then((found) => { if (found) console.log('[terminal-web] reconnected to the running terminal host'); });
    sessions = hosted;
  } else {
    sessions = localStore(local());
  }
  registerRoutes(ctx.http.router(), sessions);
  const upgrade = createUpgradeHandler(sessions);
  ctx.http.upgrade(upgrade.handle);
  // Disabling the module must not leave shells running nobody can reach. A
  // daemon restart never comes here: no shutdown hook disposes the modules.
  ctx.effect(() => () => {
    upgrade.close();
    void sessions.dispose();
  });
}
