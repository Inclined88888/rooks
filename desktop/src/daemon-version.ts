/**
 * ROO-15: a packaged shell must not serve the UI of a daemon left running from
 * an older install (launchd/systemd still answering on the configured ports).
 *
 * `/api/health` publishes `version` (orchestrator package version). A Rooks
 * answer without that field is treated as stale: every build before this gate.
 */
import { isRooks, type HealthResult } from './health.js';

export function daemonVersionOf(health: HealthResult): string | null {
  if (!health.ok) return null;
  const version = health.version;
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : null;
}

/**
 * True when this home's Rooks is answering, and its version is not the shell's.
 * Source checkouts never force a replace: developers often mix a service with
 * a rebuilt shell of the same worktree.
 */
export function daemonVersionStale(
  health: HealthResult,
  appVersion: string,
  facts: { packaged: boolean; home?: string },
): boolean {
  if (!facts.packaged) return false;
  if (!isRooks(health, facts.home)) return false;
  const running = daemonVersionOf(health);
  if (running === null) return true;
  return running !== appVersion.trim();
}

/** One line for the desktop log when a replace is required. */
export function staleDaemonLog(health: HealthResult, appVersion: string): string {
  const running = daemonVersionOf(health) ?? 'unknown (no version in /api/health)';
  return `stale daemon ${running} ≠ app ${appVersion}`;
}
