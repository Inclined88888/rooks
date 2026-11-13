/**
 * How the `tailscale` CLI must be launched on each OS.
 *
 * On macOS the standalone and App Store builds ship ONE binary inside the app
 * bundle (`Tailscale.app/Contents/MacOS/Tailscale`), which acts as the CLI only
 * when its environment looks like a shell's. Started by launchd — the daemon's
 * LaunchAgent has neither `TERM` nor `SHLVL` — it tries to start the GUI
 * instead, prints "The Tailscale GUI failed to start", exits 0 and writes no
 * JSON (the maintainer's Mac mini, 25/10/2026, Tailscale 1.104.2). `TERM=dumb` alone turns
 * it back into the CLI.
 *
 * Every launch of the tailscale CLI (status, serve, up, set) takes its
 * environment from here.
 */
import type { ExecOpts, SpawnOpts } from './types.js';

/**
 * The environment to launch `binary` with, or `undefined` when the inherited
 * one is right. A `TERM` already set is never replaced.
 */
export function tailscaleCliEnv(
  binary: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (platform !== 'darwin' || !binary.includes('.app/')) return undefined;
  if (env.TERM) return undefined;
  return { ...env, TERM: 'dumb' };
}

/** `opts` with the CLI environment of `binary` added when it needs one. */
export function tailscaleCliOpts<T extends ExecOpts | SpawnOpts>(binary: string, opts: T, platform: NodeJS.Platform = process.platform): T {
  const env = tailscaleCliEnv(binary, platform, opts.env ?? process.env);
  return env ? { ...opts, env } : opts;
}
