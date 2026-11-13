/**
 * Module `@rooks/whatsapp` — WhatsApp channel workers launched as daemon
 * children (same pattern as `@rooks/telegram`).
 *
 * - `mission-watcher` — durable inbox + reply dispatch (shared with Telegram)
 * - `whatsapp-web` — Baileys linked-device session when a whatsapp-web channel
 *   is configured
 *
 * Cloud API inbound hits the app HTTP server directly (Meta → local tunnel →
 * `/api/channels/<name>/inbound`); no poller is required for that mode.
 *
 * Disabled by default. Enable with `"@rooks/whatsapp": { "enabled": true }`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Host } from '../../host/index.js';
import type { ModuleManifest } from '../../kernel/registry.js';
import type { RooksConfig } from '../../config/schema.js';
import { config } from '../../config/load.js';
import { CHANNELS_DIR, ROOKS_HOME } from '../../paths.js';
import { superviseChild, MAX_RESTARTS, RESTART_WINDOW_MS } from '../../kernel/child-supervisor.js';
import { appDirOf, appEntryArgs, appEntryRunnable, nodeRuntime, type NodeRuntime, type AppEntry } from '../web-app/index.js';

export const manifest: ModuleManifest = {
  name: '@rooks/whatsapp',
  tier: 'opt',
  inject: ['host'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function isEnabled(cfg: RooksConfig): boolean {
  const setting = cfg.modules[manifest.name];
  if (setting === true) return true;
  if (typeof setting === 'object' && setting !== null) return setting.enabled === true;
  return false;
}

function channelTypes(dir = CHANNELS_DIR): Set<string> {
  const types = new Set<string>();
  if (!existsSync(dir)) return types;
  for (const f of readdirSync(dir).filter((name) => name.endsWith('.json') && !name.endsWith('.status.json'))) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { type?: string };
      if (typeof raw.type === 'string') types.add(raw.type);
    } catch { /* skip */ }
  }
  return types;
}

export function hasWhatsAppChannels(dir = CHANNELS_DIR): boolean {
  const types = channelTypes(dir);
  return types.has('whatsapp-cloud') || types.has('whatsapp-web');
}

export function workersFor(dir = CHANNELS_DIR): AppEntry[] {
  const types = channelTypes(dir);
  const workers: AppEntry[] = [];
  if (types.has('whatsapp-cloud') || types.has('whatsapp-web')) workers.push('mission-watcher');
  if (types.has('whatsapp-web')) workers.push('whatsapp-web');
  return workers;
}

export function envOf(cfg: RooksConfig, worker: AppEntry): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    ROOKS_HOME,
    ...(worker === 'whatsapp-web'
      ? { APP_URL: `http://127.0.0.1:${cfg.app.listen.port}` }
      : { ORCHESTRATOR_URL: `http://127.0.0.1:${cfg.daemon.listen.port}` }),
  };
}

export function superviseWorkers(host: Host, cfg: RooksConfig, appDir: string, workers: AppEntry[], node: NodeRuntime = nodeRuntime(cfg)): () => void {
  const stops = workers.map((worker) => {
    console.log(`[whatsapp] worker ${worker} served by the daemon (cwd ${appDir})`);
    return superviseChild(host, {
      label: `whatsapp/${worker}`,
      command: node.command,
      args: appEntryArgs(appDir, worker),
      spawn: { cwd: appDir, env: { ...envOf(cfg, worker), ...node.env }, stdio: 'inherit' },
      alert: {
        title: `The WhatsApp worker ${worker} stopped starting`,
        body: (why) => `${MAX_RESTARTS} restarts without staying up ${RESTART_WINDOW_MS / 1000}s (${why}). Check WhatsApp channel config and \`~/.rooks/secrets.env\`.`,
      },
    });
  });
  return () => { for (const stop of stops) stop(); };
}

export function apply(ctx: Context): void {
  const cfg = config();
  if (!isEnabled(cfg)) {
    console.log('[whatsapp] disabled (default) — enable with "@rooks/whatsapp": { "enabled": true }');
    return;
  }
  if (!hasWhatsAppChannels()) {
    console.log(`[whatsapp] no WhatsApp channel in ${CHANNELS_DIR} — nothing to launch`);
    return;
  }

  const appDir = appDirOf(cfg);
  const workers = workersFor();
  const missing = workers.find((worker) => !appEntryRunnable(appDir, worker));
  if (missing) {
    console.error(`[whatsapp] app dependencies missing: cd app && npm install (expected: ${appEntryArgs(appDir, missing)[0]})`);
    return;
  }

  ctx.effect(() => superviseWorkers(ctx.host, cfg, appDir, workers));
}
