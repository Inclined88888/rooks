/**
 * Module `@rooks/updates` — tells the user a newer Rooks is published
 * (docs/AUTO-UPDATE.md, P1b). It reads the signed `releases.json`, offers a
 * version strictly above the installed one on the build's channel, publishes
 * `update_available` and leaves one notification per version. It downloads
 * and installs nothing: the banner links to the installer.
 *
 * Tier `std`: on by default. `ROOKS_UPDATES_CHECK` (env > config > settings >
 * default on) stops every request; a build run from the sources (`dev`) and
 * the test runner never check.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { liveMissionCount, workingMissionCount } from '../../agent.js';
import { buildInfo } from '../../build-info.js';
import { bus } from '../../bus.js';
import { rooksVersion } from '../../data-version.js';
import { createNotification } from '../../notifications.js';
import { ROOKS_HOME } from '../../paths.js';
import { settingBool } from '../../settings.js';
import { UpdateChecker, stateFileIn, type UpdateOffer } from './checker.js';
import { activeReleaseKeyring } from './keyring.js';
import { registerRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '@rooks/updates',
  tier: 'std',
  inject: ['http', 'timer'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export const UPDATES_SETTING = 'ROOKS_UPDATES_CHECK';
/** First check once the daemon has settled, spread over a minute so a fleet started together does not hit the site together. */
const FIRST_CHECK_MIN_MS = 30_000;
const FIRST_CHECK_JITTER_MS = 60_000;
export const CHECK_INTERVAL_MS = 6 * 3_600_000;
/** A short tick that only looks at the clock: switching the setting back on applies without a restart. */
const TICK_MS = 10 * 60_000;

function checksAllowed(): boolean {
  return buildInfo().channel !== 'dev' && settingBool(UPDATES_SETTING);
}

export function createChecker(): UpdateChecker {
  const created: UpdateChecker = new UpdateChecker({
    enabled: () => settingBool(UPDATES_SETTING),
    channel: () => buildInfo().channel,
    buildExpiresAt: () => buildInfo().expiresAt,
    installed: rooksVersion,
    keyring: activeReleaseKeyring,
    stateFile: stateFileIn(ROOKS_HOME),
    onOffer: (offer, channel) => announce(created, offer, channel),
  });
  return created;
}

/** `update_available` for every newly found version; one notification per version, ever. */
export function announce(target: UpdateChecker, offer: UpdateOffer, channel: 'beta' | 'stable'): void {
  bus.publish({ kind: 'update_available', version: offer.version, channel });
  if (!target.markNotified(offer.version)) return;
  createNotification({
    type: 'report',
    title: `Rooks ${offer.version} is available`,
    body: `You run ${rooksVersion()}. Open Rooks to see what changed and download the installer.`,
    anchor: `rooks-update:${offer.version}`,
  });
}

export function apply(ctx: Context): void {
  const checker = createChecker();
  registerRoutes(ctx.http.router(), {
    status: () => checker.status(),
    check: () => checker.check(),
    missions: () => ({ live: liveMissionCount(), working: workingMissionCount() }),
  });

  // Not under the test runner: a suite that boots the kernel must not reach rooks.local.
  if (process.env.NODE_TEST_CONTEXT) return;
  let lastAttempt = 0;
  const tick = (): void => {
    // Off or a source build: the clock is not even read, so switching it on checks at the next tick.
    if (!checksAllowed() || Date.now() - lastAttempt < CHECK_INTERVAL_MS) return;
    lastAttempt = Date.now();
    void checker.check();
  };
  ctx.timeout(tick, FIRST_CHECK_MIN_MS + Math.floor(Math.random() * FIRST_CHECK_JITTER_MS));
  ctx.interval(tick, TICK_MS);
}
