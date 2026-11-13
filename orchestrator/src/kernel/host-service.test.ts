/**
 * Le service `host` — l'adaptateur de plateforme vu depuis l'arbre Cordis.
 *
 * Ce que ces tests protègent : qu'un module puisse obtenir l'hôte par
 * `inject: ['host']` (donc APRÈS que `boot.ts` l'ait posé, jamais avant), que
 * ce soit le MÊME objet que le singleton `getHost()` — sans quoi un module
 * injecté et un fichier hors plugin travailleraient sur deux hôtes distincts —
 * et que les capacités qui décident de l'activation des modules aient une
 * seule source : `host.capabilities()`.
 */
// Isole ROOKS_HOME AVANT tout module qui touche à l'état ROOKS (cf. test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

const { config } = await import('../config/load.js');
const { createHost, getHost } = await import('../host/index.js');
const { setHasSystemdForTest } = await import('../host/systemd.js');
const { createHostPlugin } = await import('./host-service.js');
const { diagnose } = await import('../doctor.js');

test("un module qui injecte `host` reçoit l'adaptateur posé par le boot", async () => {
  const host = createHost(config());
  const root = new Context();
  await root.plugin(createHostPlugin(host));

  let seen: unknown = null;
  await root.plugin({
    name: 'consommateur',
    inject: ['host'],
    apply(ctx: Context) { seen = ctx.host; },
  });

  assert.equal(seen, host, "le module doit voir l'hôte du boot, pas une copie");
});

test('sans fournisseur, un module qui injecte `host` reste PENDING', async () => {
  const root = new Context();
  let applied = false;
  await root.plugin({ name: 'orphelin', inject: ['host'], apply() { applied = true; } });
  // C'est le comportement Cordis attendu, et c'est pourquoi `boot.ts` pose le
  // service AVANT de créer les entrées du loader.
  assert.equal(applied, false);
});

test('le singleton et le service rendent le même hôte', () => {
  const host = createHost(config());
  assert.equal(getHost(), host);
});

test("les capacités de l'hôte ne sont pas vides sur cette machine", () => {
  const caps = createHost(config()).capabilities();
  assert.ok(caps.length > 0, 'une machine de dev sait au moins faire du git');
  assert.ok(caps.includes('git'), 'git est présent dans le PATH de ce dépôt');
});

test('la capacité systemd suit la sonde du manager utilisateur', () => {
  // Linux does not imply systemd: `createHost` only lists it when
  // `hasSystemd()` has reached the user manager. An agent scope without
  // a session (`XDG_RUNTIME_DIR` / bus missing) fails that probe, and
  // asserting the capability from `process.platform` alone is a phantom
  // red. Inject the probe — same hook as `resources.test.ts` — so both
  // branches run on every machine.
  try {
    setHasSystemdForTest(true);
    const withManager = createHost(config()).capabilities();
    if (process.platform === 'linux') {
      assert.ok(
        withManager.includes('systemd'),
        'reachable user manager → linux host lists systemd',
      );
    } else {
      assert.equal(
        withManager.includes('systemd'),
        false,
        'non-linux never lists systemd, even with the probe forced on',
      );
    }

    setHasSystemdForTest(false);
    const withoutManager = createHost(config()).capabilities();
    assert.equal(
      withoutManager.includes('systemd'),
      false,
      'unreachable user manager → generic host, systemd absent from capabilities',
    );
  } finally {
    setHasSystemdForTest(null);
  }
});

test('le diagnostic ne recalcule plus les capacités, il lit celles de l\'hôte', () => {
  const host = createHost(config());
  assert.deepEqual(diagnose().capabilities, host.capabilities());
});
