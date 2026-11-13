/**
 * `systemctl --user` probe and helper, extracted verbatim from `resources.ts`.
 *
 * They live here so that `createHost()` decides linux vs generic without importing
 * `resources.ts` (otherwise a cycle: resources → host → resources).
 */
import { spawnSync } from 'node:child_process';

let systemdAvailable: boolean | null = null;
let systemctlForTest: ((args: string[]) => { ok: boolean; out: string }) | null = null;

/** Number of real executions of the `systemctl` binary since the process
 *  started. Used by the test that checks a disabled guard runs
 *  NO systemd command: an assertion on the return value would not
 *  prove it (0 is also the result of actually stopping 0 scopes). */
let systemctlCalls = 0;
export function systemctlCallCount(): number {
  return systemctlCalls;
}

/** Test-only: freezes `hasSystemd()` without probing the machine's manager. */
export function setHasSystemdForTest(value: boolean | null): void {
  systemdAvailable = value;
}

/** Test-only: intercepts `systemctl --user` so as never to talk to the real
 *  manager. `null` restores the binary. */
export function setSystemctlForTest(fn: ((args: string[]) => { ok: boolean; out: string }) | null): void {
  systemctlForTest = fn;
}

/**
 * States from `systemctl is-system-running` where the user manager can still
 * create scopes and units. `degraded` exits non-zero but is usable (failed
 * units elsewhere). `offline` / `unknown` mean no usable user bus — common
 * in containers, cloud VMs, and sessions without `systemd --user`.
 */
const USABLE_USER_MANAGER = new Set(['running', 'degraded', 'starting', 'initializing', 'maintenance']);

/** Whether `is-system-running` stdout names a manager we can talk to. */
export function userManagerUsable(state: string): boolean {
  return USABLE_USER_MANAGER.has(state.trim().toLowerCase());
}

/** Probes only once: without a user systemd manager (container, macOS,
 *  CI), this whole module steps back and the spawn stays bare. Better an
 *  unconfined mission than a mission that does not start. */
export function hasSystemd(): boolean {
  if (systemdAvailable !== null) return systemdAvailable;
  if (process.platform !== 'linux') return (systemdAvailable = false);
  systemctlCalls += 1;
  const r = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' });
  // Exit code alone is not enough: `degraded` is non-zero yet usable, while
  // `offline` prints a word and still has no user bus (install then fails
  // with "Cannot verify the daemon service identity").
  const state = typeof r.stdout === 'string' ? r.stdout.trim() : '';
  systemdAvailable = r.error === undefined && userManagerUsable(state);
  if (!systemdAvailable) console.warn('[resources] no systemd user manager — guard inactive');
  return systemdAvailable;
}

export function systemctl(args: string[], opts: { timeoutMs?: number } = {}): { ok: boolean; out: string } {
  systemctlCalls += 1;
  if (systemctlForTest) return systemctlForTest(args);
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
