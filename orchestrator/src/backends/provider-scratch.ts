/**
 * S3 — `ctx.provider.scratch`: where the daemon keeps a provider plugin's
 * per-mission state (`docs/PROVIDERS-SDK.md` § 6.1, § 8).
 *
 * The product's own providers keep theirs in `codex-runs/`, `grok-runs/`,
 * `copilot-runs/`, `system-prompts/` — each hand-made, each with its own purge.
 * A plugin gets one folder per mission under `<TIMON_HOME>/provider-runs/<plugin>/`:
 * private (0700), namespaced by plugin (one cannot reach another's), created on the
 * first request of a LAUNCH. Whatever the CLI stores there — a session store — lives
 * as long as the conversation can be resumed: a kill keeps it (a terminated mission
 * reopens on the next message, TIM-0111), a backend switch removes it, and
 * `purgeProviderScratch` removes it once the mission has been over for a retention.
 *
 * A probe is not a mission: with no launch in progress nothing is created
 * (`BackendLaunchContext.kind === 'probe'`).
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { protectedHomeDirProblem } from './credential-home-dirs.js';
import { TIMON_HOME } from '../paths.js';
import type { LaunchSeal } from './launch-seal.js';
import { forgetProviderMediaRoots } from './provider-media.js';
import { createScratchDir, type ProviderScratchDir } from './scratch-dir.js';

/**
 * The per-mission folders the product's providers kept before they became plugins, by the plugin that
 * took them over. A mission that was open across the update has its CLI's session store in the old
 * folder (`codex exec resume` finds its rollout there, nowhere else): the new folder adopts it, once,
 * the first time the plugin asks for the mission's folder — and is purged with it.
 */
const LEGACY_RUN_DIRS: Readonly<Record<string, string>> = { 'provider-codex': 'codex-runs' };

function legacyMissionDir(pluginId: string, missionId: string): string | null {
  const name = LEGACY_RUN_DIRS[pluginId];
  return name ? join(TIMON_HOME, name, missionId) : null;
}

/** Moves the mission's old folder to the plugin's, if the plugin has none yet. Best effort: a failed move leaves the CLI a fresh folder, as before this existed. */
function adoptLegacyMissionDir(pluginId: string, missionId: string): void {
  const from = legacyMissionDir(pluginId, missionId);
  const to = missionScratchPath(pluginId, missionId);
  if (!from || existsSync(to) || !existsSync(from)) return;
  try {
    mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 });
    renameSync(from, to);
  } catch (error) {
    console.warn(`[provider-scratch] could not carry ${from} over to ${to}: ${(error as Error).message}`);
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function providerRunsDir(): string {
  return join(TIMON_HOME, 'provider-runs');
}

/** Where `openMissionScratch` puts the folder of `missionId` for `pluginId` (nothing is created). */
export function missionScratchPath(pluginId: string, missionId: string): string {
  return join(providerRunsDir(), segment('plugin id', pluginId), segment('mission id', missionId));
}

function segment(kind: string, value: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`${kind} \`${value.slice(0, 40)}\` is not a safe folder name`);
  return value;
}

/** Thrown when a scratch folder is asked for outside a launch: there is no mission to keep it for. */
export class ScratchWithoutLaunchError extends Error {
  constructor() {
    super('ctx.provider.scratch needs a launch in progress (call it from buildSpawn/launch or openSession): a probe has no mission to keep a folder for');
    this.name = 'ScratchWithoutLaunchError';
  }
}

/**
 * The folders the operator pointed a CLI's sign-in to by environment (`CODEX_AUTH_DIR`), as the
 * places `link` may take a source from. A folder of its own, never the home folder, a parent of
 * it, or a filesystem root: those would let a link reach every credential of the user.
 */
export function envCredentialRoots(names: readonly string[], env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  return names.flatMap((name) => {
    const value = env[name];
    if (!value || !isAbsolute(value)) return [];
    const dir = resolve(value);
    const fromDir = relative(dir, home);
    const homeIsInside = fromDir === '' || (!fromDir.startsWith('..') && !isAbsolute(fromDir));
    return homeIsInside || dir === parse(dir).root ? [] : [dir];
  });
}

/**
 * The scratch folder of `missionId` for plugin `pluginId`. `seal` is the launch in
 * progress — its references are written back as values inside the files — and
 * `credentialDirs` the folders (relative to the home) the plugin's providers
 * declared, the only places `link` takes a source from.
 */
export function openMissionScratch(input: {
  pluginId: string;
  missionId: string;
  seal: LaunchSeal | undefined;
  credentialDirs: readonly string[];
  /** Absolute folders, beyond the home-relative `credentialDirs`, `link` may take a source from: the account folders of this plugin's backends, the folders an operator variable names. */
  extraLinkRoots?: readonly string[];
  home?: string;
}): ProviderScratchDir {
  if (!input.seal) throw new ScratchWithoutLaunchError();
  const { seal } = input;
  adoptLegacyMissionDir(input.pluginId, input.missionId);
  const home = input.home ?? homedir();
  return createScratchDir({
    root: missionScratchPath(input.pluginId, input.missionId),
    swap: (text, escape) => seal.swap(text, escape),
    // Second lock: a folder registration would refuse is not a root even if it got into the list another way.
    linkRoots: [
      ...input.credentialDirs.filter((dir) => protectedHomeDirProblem(dir) === null).map((dir) => join(home, ...dir.split('/'))),
      ...(input.extraLinkRoots ?? []),
    ],
  });
}

/** The mission is explicitly done with: every plugin's folder for it goes, with the CLI's session store inside. */
export function disposeProviderScratch(missionId: string): void {
  if (!SAFE_SEGMENT.test(missionId)) return;
  forgetProviderMediaRoots(missionId);
  for (const pluginId of Object.keys(LEGACY_RUN_DIRS)) {
    const legacy = legacyMissionDir(pluginId, missionId);
    if (legacy) try { rmSync(legacy, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  const base = providerRunsDir();
  if (!existsSync(base)) return;
  for (const plugin of readdirSync(base)) {
    try { rmSync(join(base, plugin, missionId), { recursive: true, force: true }); } catch { /* best effort, like every dispose */ }
  }
}

/** A parked folder stays a sibling of the live ones: named after no mission, the retention purge dates it by itself if a daemon dies before settling it. */
const PARKED_SUFFIX = '.handover';

export type ParkedProviderScratch = {
  /** The launch failed: drops what it wrote and puts the folders back. */
  restore(): void;
  /** The new backend took over: the folders are of no further use. */
  drop(): void;
};

/**
 * `disposeProviderScratch` that can be taken back. A backend switch empties the
 * mission's folders before its launch, since the new CLI may be served by the
 * same plugin, but a launch that fails must leave the old session resumable.
 */
export function parkProviderScratch(missionId: string): ParkedProviderScratch {
  if (!SAFE_SEGMENT.test(missionId)) return { restore() {}, drop() {} };
  forgetProviderMediaRoots(missionId);
  const legacy = Object.keys(LEGACY_RUN_DIRS).flatMap((pluginId) => legacyMissionDir(pluginId, missionId) ?? []);
  const base = providerRunsDir();
  const parked: string[] = [];
  for (const dir of [...legacy, ...listDir(base).map((plugin) => join(base, plugin, missionId))]) {
    if (!existsSync(dir)) continue;
    try {
      rmSync(`${dir}${PARKED_SUFFIX}`, { recursive: true, force: true });
      renameSync(dir, `${dir}${PARKED_SUFFIX}`);
      parked.push(dir);
    } catch {
      // A folder that cannot move (a file still held on Windows) goes the way of
      // a dispose: the new CLI must not inherit it. This session is then lost.
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort, like every dispose */ }
    }
  }
  return {
    restore() {
      disposeProviderScratch(missionId);
      for (const dir of parked) {
        try { renameSync(`${dir}${PARKED_SUFFIX}`, dir); } catch (error) {
          console.warn(`[provider-scratch] could not put ${dir} back: ${(error as Error).message}`);
        }
      }
    },
    drop() {
      for (const dir of parked) {
        try { rmSync(`${dir}${PARKED_SUFFIX}`, { recursive: true, force: true }); } catch { /* the retention purge takes it */ }
      }
    },
  };
}

/** Folders no provider writes any more, left on the disk of an install older than the provider plugins. */
const RETIRED_RUN_DIRS: readonly string[] = ['grok-runs'];

/** What the database says of a mission, for the purge: `live` = running, or reopened by a resume. */
export type ScratchMissionLifetime = { live: boolean; endedAt: number | null };

export type ScratchPurgeOutcome = { removed: string[]; keptLive: number; keptRecent: number };

/**
 * Removes the per-mission folders — every plugin's, and the ones the product's providers kept
 * before they became plugins — of missions over for at least `ttlMs`.
 *
 * Never on age alone: a folder is named after its mission and `lifetimeOf` reads the database.
 * A running mission, including one a resume brought back (`reopenMission` clears `ended_at`), is
 * never touched whatever its age: its folder may hold the thread it is about to resume. A folder
 * with no mission row (a one-shot launch, a purged row) falls back on its own date.
 */
export function purgeProviderScratch(
  lifetimeOf: (missionId: string) => ScratchMissionLifetime | null,
  ttlMs: number,
  now: number = Date.now(),
): ScratchPurgeOutcome {
  const out: ScratchPurgeOutcome = { removed: [], keptLive: 0, keptRecent: 0 };
  const roots = [...Object.values(LEGACY_RUN_DIRS), ...RETIRED_RUN_DIRS].map((name) => join(TIMON_HOME, name));
  const base = providerRunsDir();
  for (const plugin of listDir(base)) roots.push(join(base, plugin));
  for (const root of roots) {
    for (const missionId of listDir(root)) {
      const dir = join(root, missionId);
      let since: number | null;
      try {
        if (!statSync(dir).isDirectory()) continue;
        const life = lifetimeOf(missionId);
        if (life?.live) { out.keptLive += 1; continue; }
        since = life?.endedAt ?? statSync(dir).mtimeMs;
      } catch { continue; }
      if (now - since < ttlMs) { out.keptRecent += 1; continue; }
      try {
        rmSync(dir, { recursive: true, force: true });
        forgetProviderMediaRoots(missionId);
        out.removed.push(missionId);
      } catch (error) {
        console.warn(`[provider-scratch] could not purge ${dir}: ${(error as Error).message}`);
      }
    }
  }
  return out;
}

function listDir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
