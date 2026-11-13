/**
 * ROO-15: stop a Rooks daemon whose `/api/health` version is not this app's,
 * then bring a matching one up (service upgrade + start, or embedded fallback).
 */
import { daemonVersionStale, staleDaemonLog } from './daemon-version.js';
import { isRooks, type HealthResult } from './health.js';

export type ReplaceStaleResult =
  | { action: 'none'; health: HealthResult }
  | { action: 'replaced'; health: HealthResult; via: 'service' | 'embedded' }
  | { action: 'failed'; health: HealthResult; reason: string };

export type ReplaceStaleDeps = {
  packaged: boolean;
  home: string;
  appVersion: string;
  serviceInstalled: boolean;
  probe: () => Promise<HealthResult>;
  waitForMatch: (budgetMs: number) => Promise<HealthResult>;
  waitUntilGone: (budgetMs: number) => Promise<HealthResult>;
  stopService: () => Promise<void>;
  upgradeService: () => Promise<void>;
  startService: () => Promise<void>;
  startEmbedded: () => Promise<HealthResult>;
  log?: (line: string) => void;
  serviceBootBudgetMs?: number;
  stopBudgetMs?: number;
};

const DEFAULT_STOP_BUDGET_MS = 15_000;
const DEFAULT_SERVICE_BOOT_MS = 60_000;

export async function replaceStaleDaemon(initial: HealthResult, deps: ReplaceStaleDeps): Promise<ReplaceStaleResult> {
  const log = deps.log ?? (() => undefined);
  if (!daemonVersionStale(initial, deps.appVersion, { packaged: deps.packaged, home: deps.home })) {
    return { action: 'none', health: initial };
  }
  log(`[desktop] ${staleDaemonLog(initial, deps.appVersion)}`);

  if (deps.serviceInstalled) {
    try {
      await deps.stopService();
      log('[desktop] stopped stale background service');
    } catch (error) {
      log(`[desktop] stop of stale service failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await deps.waitUntilGone(deps.stopBudgetMs ?? DEFAULT_STOP_BUDGET_MS);
    try {
      await deps.upgradeService();
      log('[desktop] restaged packaged service after stale daemon');
    } catch (error) {
      log(`[desktop] restage after stale daemon failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await deps.startService();
    } catch (error) {
      log(`[desktop] start after stale daemon failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const afterService = await deps.waitForMatch(deps.serviceBootBudgetMs ?? DEFAULT_SERVICE_BOOT_MS);
    if (isRooks(afterService, deps.home)
      && !daemonVersionStale(afterService, deps.appVersion, { packaged: deps.packaged, home: deps.home })) {
      return { action: 'replaced', health: afterService, via: 'service' };
    }
  } else {
    // Orphan process on our ports: wait briefly in case it exits; then embed
    // only works if the port frees. startEmbedded decides.
    await deps.waitUntilGone(Math.min(deps.stopBudgetMs ?? DEFAULT_STOP_BUDGET_MS, 5_000));
  }

  const afterEmbedded = await deps.startEmbedded();
  if (isRooks(afterEmbedded, deps.home)
    && !daemonVersionStale(afterEmbedded, deps.appVersion, { packaged: deps.packaged, home: deps.home })) {
    return { action: 'replaced', health: afterEmbedded, via: 'embedded' };
  }
  const still = await deps.probe();
  return {
    action: 'failed',
    health: still,
    reason: daemonVersionStale(still, deps.appVersion, { packaged: deps.packaged, home: deps.home })
      ? staleDaemonLog(still, deps.appVersion)
      : 'daemon did not come back as this home after replace',
  };
}

/** Poll until this home's Rooks is gone (or the budget ends). */
export async function waitUntilDaemonGone(
  probe: () => Promise<HealthResult>,
  home: string,
  budgetMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<HealthResult> {
  const deadline = Date.now() + budgetMs;
  let last = await probe();
  while (isRooks(last, home) && Date.now() < deadline) {
    await sleep(300);
    last = await probe();
  }
  return last;
}
