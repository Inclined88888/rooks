/**
 * Module `@rooks/machines` — the fleet of machines (multi-machine, TODO #329).
 *
 * The other Rooks daemons a person of THIS daemon pairs with, so that one
 * interface switches from one machine to another on the same origin: the app
 * relays to the active machine with the device token kept here. This module
 * is the host half: the registry, sealed in the vault (`machines/store.ts`),
 * its routes (`machines/http.ts`) and the push relay (`machines/push-relay.ts`). The settings page and the switcher are
 * its client half (P3d).
 *
 * Shipped OFF (`offByDefault` in the catalog): it keeps credentials to other
 * computers, a door the user opens on purpose. It needs the accounts (only a
 * browser session owns a fleet) and the vault (where the tokens live).
 *
 * What it does NOT carry: device pairing itself (`users/devices*.ts`). The
 * machine being reached accepts a device without this module, which is only
 * needed on the machine that keeps the fleet.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerMachineRoutes } from '../../machines/http.js';
import { startMachinePushRelay } from '../../machines/push-relay.js';
import { ensureMachineSchema } from '../../machines/store.js';

export const manifest: ModuleManifest = {
  name: '@rooks/machines',
  tier: 'opt',
  // Paid licences only (the maintainer, 25/10/2026); mirrored in the catalogue.
  licensed: true,
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  ensureMachineSchema();
  registerMachineRoutes(ctx.http.router());
  // One event stream per machine of the fleet, its notifications raised here
  // (and pushed to the phone). Stopped with the module.
  ctx.effect(() => startMachinePushRelay());
}
