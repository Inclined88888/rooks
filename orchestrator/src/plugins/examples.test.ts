/**
 * Les gabarits d'`examples/` chargent-ils vraiment ?
 *
 * Ils sont la promesse open-core rendue vérifiable : un tiers doit pouvoir
 * écrire une surface du produit sans toucher au daemon. Un gabarit qui ne
 * charge plus (manifeste périmé, capacité disparue du SDK) est une régression
 * du CONTRAT, pas un exemple de documentation à rafraîchir un jour.
 *
 * Le moniteur de quotas est le cas de référence : il a d'abord été livré en
 * module bundled, puis réécrit ici avec le seul SDK. S'il cesse de fonctionner,
 * c'est que le SDK a perdu quelque chose que le produit, lui, a gardé.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { PluginLoader } = await import('./loader.js');
const { daemonHost } = await import('./context.js');
const { attachPluginLoader } = await import('./runtime.js');
const { registerRoutes } = await import('../plugins-bundled/plugins/routes.js');
const { preserveLastUsage, quotaShouldKeepPolling, readHistory } = await import('../../../examples/plugin-quota-monitor/lib/index.js');
const { resetClaudeUsageCache } = await import('../../tests/helpers/claude-provider.js');

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '../../../examples');

test('plugin-quota-monitor : conserve la dernière mesure quand une sonde échoue', async () => {
  const values = new Map<string, unknown>();
  const ctx = { storage: { kv: {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => { values.set(key, value); },
  } } };
  const usage = {
    windows: { five_hour: { utilization: 31, resets_at: '2026-09-04T18:00:00Z' } },
    extra: null,
  };
  await preserveLastUsage(ctx, { backend: 'provider-a', available: true, usage }, 1000);
  const stale = await preserveLastUsage(ctx, {
    backend: 'provider-a', available: false, usage: null, error: 'rate limited',
  }, 2000);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.stale, true);
  assert.equal(stale.staleAt, 1000);
  assert.equal(stale.risk, 31);
  assert.deepEqual(stale.usage, usage);

  const idle = await preserveLastUsage(ctx, {
    backend: 'provider-a', available: false, usage: null, connected: false, reason: 'not_signed_in',
  }, 3000);
  assert.equal(idle.state, 'disconnected');
  assert.equal(idle.stale, false);
  assert.equal(idle.usage, null);

  // Claude idle + Codex unsupported must not keep probing: a session will
  // not appear by retrying. A measured (or transiently failed) probe still
  // warrants the loop.
  assert.equal(quotaShouldKeepPolling([
    { state: 'disconnected' },
    { state: 'unsupported' },
  ]), false);
  assert.equal(quotaShouldKeepPolling([{ state: 'disconnected' }]), false);
  assert.equal(quotaShouldKeepPolling([
    { state: 'available' },
    { state: 'unsupported' },
  ]), true);
  assert.equal(quotaShouldKeepPolling([{ state: 'unavailable' }]), true);
  assert.equal(quotaShouldKeepPolling([]), true);
});

/** Installe un dossier d'`examples/` comme le ferait `rooks plugin add`. */
function installExample(root: string, folder: string, pkgName: string): void {
  const dest = join(root, 'node_modules', pkgName);
  mkdirSync(dirname(dest), { recursive: true });
  try { symlinkSync(join(EXAMPLES, folder), dest, 'dir'); } catch { /* déjà lié */ }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'rooks-plugins', private: true, dependencies: { [pkgName]: 'file:example' } }, null, 2),
  );
}

async function withExample(
  folder: string,
  pkgName: string,
  body: (url: (path: string) => string, loader: PluginLoader) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  registerRoutes(ctx.http.router());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'rooks-examples-'));
  installExample(dir, folder, pkgName);
  const loader = new PluginLoader(ctx, {
    dir,
    host: daemonHost(ctx),
    plugins: () => ({}),
    // Les gabarits ne sont pas signés : sans ça la suite mesurerait la
    // signature, pas le contrat.
    allowUnsigned: () => true,
  });
  attachPluginLoader(app, loader);
  try {
    const [record] = await loader.update();
    assert.equal(record?.state, 'active', `gabarit refusé : ${record?.error ?? 'raison inconnue'}`);
    await body((path) => `http://127.0.0.1:${port}${path}`, loader);
  } finally {
    await loader.dispose();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
    await ctx.fiber.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withoutClaudeSession<T>(run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-examples-no-oauth-'));
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  resetClaudeUsageCache();
  try {
    return await run();
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('plugin-quota-monitor: the trend only carries the backends the caller can see (TODO #330)', async () => {
  // The plugin's storage is shared by every user; Bob's account must not
  // reach Ada's trend through it.
  const rows = [
    { key: 'history:1:claude', value: { at: 1, backend: 'claude', risk: 10 } },
    { key: 'history:1:claude@bobaccount', value: { at: 1, backend: 'claude@bobaccount', risk: 50 } },
    { key: 'history:2:claude@adaaccount', value: { at: 2, backend: 'claude@adaaccount', risk: 20 } },
  ];
  const ctx = { storage: { kv: { list: async () => rows } } };
  const points = await readHistory(ctx, new Set(['claude', 'claude@adaaccount'])) as Array<{ backend: string }>;
  assert.deepEqual(points.map((point) => point.backend), ['claude', 'claude@adaaccount']);
});

test('plugin-quota-monitor : le produit entier tient dans le SDK', { concurrency: false }, async () => {
  await withoutClaudeSession(async () => {
    await withExample('plugin-quota-monitor', '@rooks/plugin-quota-monitor', async (url) => {
      // `usage:read` : un backend actif par entrée, seuils venus des réglages
      // déclarés au manifeste. Sans session CLI, Claude est idle (`disconnected`),
      // pas une panne — les autres sondes restent unsupported / unavailable.
      const all = await (await fetch(url('/api/plugins/quota-monitor/all'))).json() as {
        entries: { backend: string; state: string; risk: number | null }[];
        thresholds: { warning: number; critical: number };
      };
      assert.ok(all.entries.length > 0, 'au moins un backend actif');
      assert.deepEqual(all.thresholds, { warning: 70, critical: 90 });
      const states = ['available', 'unsupported', 'unavailable', 'disconnected'];
      for (const entry of all.entries) {
        assert.ok(states.includes(entry.state), `état inattendu: ${entry.state}`);
        // Jamais un zéro de substitution : sans mesure, pas de chiffre.
        if (entry.state !== 'available') assert.equal(entry.risk, null);
      }
      const claude = all.entries.find((entry) => entry.backend === 'claude');
      assert.ok(claude, 'claude reste au catalogue');
      assert.equal(claude.state, 'disconnected');
      assert.equal(claude.risk, null);

      // The ↻ (`?refresh=1`, TODO #632) reads the same catalogue, probes forced.
      const refreshed = await fetch(url('/api/plugins/quota-monitor/all?refresh=1'));
      assert.equal(refreshed.status, 200);
      const forced = await refreshed.json() as { entries: { backend: string }[] };
      assert.deepEqual(forced.entries.map((entry) => entry.backend), all.entries.map((entry) => entry.backend));

      // `storage` : l'appel précédent a écrit l'historique dans le KV du plugin.
      const history = await (await fetch(url('/api/plugins/quota-monitor/history'))).json() as {
        retentionDays: number; points: { backend: string; risk: number }[];
      };
      assert.equal(history.retentionDays, 90);

      // La galerie voit le plugin comme n'importe quel tiers, avec ses deux
      // prises et sa moitié navigateur servie. Plus de `topbar.item` : l'anneau
      // est la forme à plat de son widget, sur la ligne de la barre.
      const gallery = await (await fetch(url('/api/plugins/quota-monitor'))).json() as {
        state: string; kind: string[]; client: { slots: string[] } | null;
      };
      assert.equal(gallery.state, 'active');
      assert.deepEqual(gallery.kind, ['widget']);
      assert.deepEqual(gallery.client?.slots, ['cockpit.widget', 'settings.section']);
    });
  });
});

test('plugin-hello : un manifeste `apiVersion 1` charge toujours', async () => {
  // La politique additive (sdk.1) en un test : le daemon implémente le contrat
  // 2, ce gabarit demande le 1, il tourne.
  await withExample('plugin-hello', '@rooks/plugin-hello', async (url) => {
    const body = await (await fetch(url('/api/plugins/plugin-hello/hello'))).json() as { greeting: string };
    assert.equal(body.greeting, 'Bonjour depuis un plugin');
  });
});

test('plugin-provider : un fournisseur tiers se charge sans clé ni allowlist', async () => {
  // Le gabarit doit rester installable en configuration NUE : sans clé son
  // profil drop-in reste inactif, et sans allowlist son dialecte de démo est
  // refusé — deux refus attendus, qui ne doivent pas faire échouer `apply`.
  await withExample('plugin-provider', '@rooks/plugin-provider', async (url) => {
    const gallery = await (await fetch(url('/api/plugins/provider-example'))).json() as {
      state: string; kind: string[]; client: unknown;
    };
    assert.equal(gallery.state, 'active');
    assert.deepEqual(gallery.kind, ['provider']);
    assert.equal(gallery.client, null, 'un fournisseur n\'a pas de moitié navigateur');
  });
});

test('plugin-model-picker: a browser-only replacement of `model.picker` loads at API 13', async () => {
  await withExample('plugin-model-picker', '@rooks/plugin-model-picker', async (url) => {
    const gallery = await (await fetch(url('/api/plugins/example-model-picker'))).json() as {
      state: string; kind: string[]; client: { slots: string[] } | null;
    };
    assert.equal(gallery.state, 'active');
    assert.deepEqual(gallery.kind, ['behavior']);
    assert.deepEqual(gallery.client?.slots, ['model.picker']);
  });
});

test('plugin-provider-cards: a browser-only replacement of `providers.cli` loads at API 14', async () => {
  await withExample('plugin-provider-cards', '@rooks/plugin-provider-cards', async (url) => {
    const gallery = await (await fetch(url('/api/plugins/example-provider-cards'))).json() as {
      state: string; kind: string[]; client: { slots: string[] } | null;
    };
    assert.equal(gallery.state, 'active');
    assert.deepEqual(gallery.kind, ['behavior']);
    assert.deepEqual(gallery.client?.slots, ['providers.cli']);
  });
});

test('plugin-app-card: a browser-only replacement of `apps.card` loads at API 15', async () => {
  await withExample('plugin-app-card', '@rooks/plugin-app-card', async (url) => {
    const gallery = await (await fetch(url('/api/plugins/example-app-card'))).json() as {
      state: string; kind: string[]; client: { slots: string[] } | null;
    };
    assert.equal(gallery.state, 'active');
    assert.deepEqual(gallery.kind, ['behavior']);
    assert.deepEqual(gallery.client?.slots, ['apps.card']);
  });
});

for (const [dir, pkg, id, slot] of [
  ['plugin-kanban-card', '@rooks/plugin-kanban-card', 'example-kanban-card', 'kanban.card'],
  ['plugin-todo-form', '@rooks/plugin-todo-form', 'example-todo-form', 'todo.form'],
] as const) {
  test(`${dir}: a browser-only replacement of \`${slot}\` loads at API 15`, async () => {
    await withExample(dir, pkg, async (url) => {
      const gallery = await (await fetch(url(`/api/plugins/${id}`))).json() as {
        state: string; kind: string[]; client: { slots: string[] } | null;
      };
      assert.equal(gallery.state, 'active');
      assert.deepEqual(gallery.kind, ['behavior']);
      assert.deepEqual(gallery.client?.slots, [slot]);
    });
  });
}

test('plugin-page-toc: a browser-only replacement of `page.toc` loads at API 15', async () => {
  await withExample('plugin-page-toc', '@rooks/plugin-page-toc', async (url) => {
    const gallery = await (await fetch(url('/api/plugins/example-page-toc'))).json() as {
      state: string; kind: string[]; client: { slots: string[] } | null;
    };
    assert.equal(gallery.state, 'active');
    assert.deepEqual(gallery.kind, ['behavior']);
    assert.deepEqual(gallery.client?.slots, ['page.toc']);
  });
});

test('plugin-mascot: a browser-only replacement of `agent.mascot` loads at API 15', async () => {
  await withExample('plugin-mascot', '@rooks/plugin-mascot', async (url) => {
    const gallery = await (await fetch(url('/api/plugins/example-mascot'))).json() as {
      state: string; kind: string[]; client: { slots: string[] } | null;
    };
    assert.equal(gallery.state, 'active');
    assert.deepEqual(gallery.kind, ['behavior']);
    assert.deepEqual(gallery.client?.slots, ['agent.mascot']);
  });
});

test('plugin-email-code: a browser-only replacement of `email.code` loads at API 15', async () => {
  await withExample('plugin-email-code', '@rooks/plugin-email-code', async (url) => {
    const gallery = await (await fetch(url('/api/plugins/example-email-code'))).json() as {
      state: string; kind: string[]; client: { slots: string[] } | null;
    };
    assert.equal(gallery.state, 'active');
    assert.deepEqual(gallery.kind, ['behavior']);
    assert.deepEqual(gallery.client?.slots, ['email.code']);
  });
});

test('plugin-look-styler: a browser-only replacement of `agent.lookstyler` loads at API 15', async () => {
  await withExample('plugin-look-styler', '@rooks/plugin-look-styler', async (url) => {
    const gallery = await (await fetch(url('/api/plugins/example-look-styler'))).json() as {
      state: string; kind: string[]; client: { slots: string[] } | null;
    };
    assert.equal(gallery.state, 'active');
    assert.deepEqual(gallery.kind, ['behavior']);
    assert.deepEqual(gallery.client?.slots, ['agent.lookstyler']);
  });
});

test('plugin-mascot-pack: its declared parts load at API 15 and become valid in a look', async () => {
  const { parseAgentLook } = await import('../agent-look.js');
  const { mascotPartsOf } = await import('./mascot-packs.js');
  await withExample('plugin-mascot-pack', '@rooks/plugin-mascot-pack', async (url, loader) => {
    const gallery = await (await fetch(url('/api/plugins/example-mascot-pack'))).json() as {
      state: string; kind: string[]; client: { slots: string[] } | null; mascot: Record<string, string[]> | null;
    };
    assert.equal(gallery.state, 'active');
    assert.deepEqual(gallery.kind, ['behavior']);
    assert.deepEqual(gallery.client?.slots, ['mascot.parts']);
    assert.deepEqual(gallery.mascot, { acc: ['beanie', 'scarf'], color: ['midnight'], eyes: ['snowflake'] });
    const catalog = mascotPartsOf(loader.list());
    const look = { shape: 'round', color: 'example-mascot-pack:midnight', eyes: 'example-mascot-pack:snowflake', acc: 'example-mascot-pack:beanie' };
    assert.deepEqual(parseAgentLook(look, catalog), look);
    assert.throws(() => parseAgentLook({ ...look, acc: 'example-mascot-pack:mittens' }, catalog), /not declared for this field/);
  });
});

test('plugin-remote-backend :un backend sans process se charge sans allowlist et entre au catalogue', async () => {
  const { backendNames, getBackend } = await import('../backends/index.js');
  // Aucune entrée `pluginPolicy.exec.allow` : il n'y a pas de binaire à autoriser.
  await withExample('plugin-remote-backend', '@rooks/plugin-remote-backend', async (url) => {
    const gallery = await (await fetch(url('/api/plugins/remote-backend-example'))).json() as {
      state: string; kind: string[];
    };
    assert.equal(gallery.state, 'active');
    assert.deepEqual(gallery.kind, ['provider']);
    assert.ok(backendNames().includes('memory-remote'), 'le profil distant est dispatchable');
    assert.equal(typeof getBackend('memory-remote').openRemoteSession, 'function');
  });
  // Retiré au déchargement, comme tout ce qu'un plugin a apporté.
  assert.equal(backendNames().includes('memory-remote'), false);
});

test('plugin-user-connection : déclare son type de connexion et répond 401 sans compte', async () => {
  const { integrationRegistries } = await import('./integration-host.js');
  await withExample('plugin-user-connection', '@rooks/plugin-user-connection', async (url) => {
    const lease = integrationRegistries.connectionTypes.get('user-connection-example:service@1');
    assert.equal(lease?.definition.label, 'Example service');
    assert.deepEqual(lease?.definition.secrets?.map((s) => s.name), ['apiKey']);
    assert.deepEqual(lease?.definition.configSchema.parse({ workspace: 'main' }), { workspace: 'main' });
    assert.throws(() => lease?.definition.configSchema.parse({ owner: 'x' }));
    // No account on this test daemon: the route names nobody's connection.
    assert.equal((await fetch(url('/api/plugins/user-connection-example/status'))).status, 401);
  });
  assert.equal(integrationRegistries.connectionTypes.get('user-connection-example:service@1'), undefined);
});

test('plugin-dictation: admitted as a dictation plugin, its voice destinations said, its routes closed to anonymous callers', async () => {
  const { dictationEgressLines } = await import('./manifest.js');
  await withExample('plugin-dictation', '@rooks/plugin-dictation', async (url) => {
    const gallery = await (await fetch(url('/api/plugins/example-dictation'))).json() as {
      state: string; kind: string[]; client: { slots: string[] } | null;
    };
    assert.equal(gallery.state, 'active');
    assert.deepEqual(gallery.kind, ['dictation']);
    assert.deepEqual(gallery.client?.slots, ['dictation.engine']);
    // No account on this test daemon: the voice is personal, nobody's dictation opens.
    const open = await fetch(url('/api/plugins/example-dictation/sessions'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(open.status, 401);
    // Its models pack is served under the id the loader knows it by.
    const pack = await (await fetch(url('/api/plugins/example-dictation/-/dictation-models'))).json() as { pluginId: string; models: { id: string }[] };
    assert.equal(pack.pluginId, 'example-dictation');
    assert.deepEqual(pack.models.map((model) => model.id), ['example-dictation.canary-flash']);
  });
  const manifest = JSON.parse(readFileSync(join(EXAMPLES, 'plugin-dictation', 'package.json'), 'utf8')) as { rooks: unknown };
  const { readManifest } = await import('./manifest.js');
  const read = readManifest(manifest);
  assert.ok(read.ok);
  assert.deepEqual(dictationEgressLines(read.manifest), [
    'example-page: your voice stays in this window',
    'example-daemon: your voice is sent to the daemon of the active machine',
    'models: brings models for the built-in engine; your voice stays on this machine',
  ]);
});
