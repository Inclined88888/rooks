/**
 * Mounts the providers the product ships as plugins (`builtin-plugins.json`, kind `provider`) the
 * way the daemon's loader does: a plugin context marked `builtin` — which is what makes the
 * registration "official" — and the plugin's own `apply(ctx)`. A test of the registry, the
 * fallback, the doctor or the contract suite that expects `grok` to exist calls this once, before
 * it reads the registry; the day another provider moves out of the core it appears here too, and
 * no test needs editing.
 *
 * The daemon's boot does the same through `PluginLoader.update()`, with the licence and trust
 * checks on top (`plugins/builtin.ts`); the loader itself is exercised by its own tests.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';

const mountedContexts = new Map<string, import('../../src/plugins/context.js').PluginContext>();
export function mountedOfficialContext(id: string) { return mountedContexts.get(id)!; }

type Manifested = { name?: string; version?: string; main?: string; rooks?: { kind?: string | string[] } };

/** The package of an official provider listed in `builtin-plugins.json`, by its manifest id (`provider-grok`). */
async function officialPackage(pluginId: string): Promise<{ dir: string; json: Manifested; manifest: import('../../src/plugins/manifest.js').PluginManifest }> {
  const { orchestratorRoot, readBuiltinList } = await import('../../src/plugins/builtin.js');
  const { readManifest } = await import('../../src/plugins/manifest.js');
  const root = orchestratorRoot();
  // The listed providers, then the folder they all live in (a package staged before it is listed is testable too).
  const dirs = [
    ...readBuiltinList(root).map(({ source }) => resolve(root, source)),
    ...readdirSync(join(root, 'official-providers')).map((name) => join(root, 'official-providers', name)),
  ];
  for (const dir of dirs) {
    let json: Manifested;
    try { json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifested; } catch { continue; }
    const res = readManifest(json);
    if (res.ok && res.manifest.id === pluginId) return { dir, json, manifest: res.manifest };
  }
  throw new Error(`no official provider ${pluginId} in builtin-plugins.json or official-providers/`);
}

/** The context the daemon gives an official provider (`builtin: true`): its `ctx.provider` is the real one. */
export async function officialContext(pluginId: string): Promise<{ ctx: import('../../src/plugins/context.js').PluginContext; dir: string }> {
  const { createPluginContext, daemonHost } = await import('../../src/plugins/context.js');
  const { dir, json, manifest } = await officialPackage(pluginId);
  const root = new Context();
  return { ctx: createPluginContext(root, { manifest, version: json.version ?? '0.0.0', builtin: true }, { ...daemonHost(root), mountRouter: () => () => { /* A launch test mounts no HTTP server. */ } }), dir };
}

export async function mountOfficialProviders(): Promise<string[]> {
  const { orchestratorRoot, readBuiltinList } = await import('../../src/plugins/builtin.js');
  const { readManifest } = await import('../../src/plugins/manifest.js');
  const root = orchestratorRoot();
  const mounted: string[] = [];
  for (const { source } of readBuiltinList(root)) {
    const dir = resolve(root, source);
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifested;
    const kind = json.rooks?.kind;
    if (!(Array.isArray(kind) ? kind.includes('provider') : kind === 'provider')) continue;
    const res = readManifest(json);
    if (!res.ok) throw new Error(`official provider ${source}: ${res.message}`);
    if (mountedContexts.has(res.manifest.id)) { mounted.push(res.manifest.id); continue; }
    const { ctx } = await officialContext(res.manifest.id);
    const entry = await import(pathToFileURL(join(dir, json.main ?? 'lib/index.js')).href) as { apply(ctx: unknown): void | Promise<void> };
    await entry.apply(ctx);
    mountedContexts.set(res.manifest.id, ctx);
    mounted.push(res.manifest.id);
  }
  return mounted;
}

/**
 * Stand-ins for the CLIs an official provider's profile requires (`requiredBinary`): a profile
 * exists only when its CLI is found, and a file on the PATH is enough for the registry to list it.
 * Nothing here ever executes it.
 */
export async function stubCliBinaries(...names: string[]): Promise<string> {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { delimiter } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'rooks-stub-cli-'));
  for (const name of names) writeFileSync(join(dir, process.platform === 'win32' ? `${name}.cmd` : name), '', { mode: 0o755 });
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A Codex sign-in for a test that launches codex behind a fake `host.spawn`: the launch checks that
 * credentials are readable (`inspectCodexAuth`) before it builds the command. Without this the check
 * reads the operator's own `~/.codex/auth.json`, so the test passes on a machine signed in to Codex
 * and fails on a clean one (a contributor's, the CI). `CODEX_AUTH_DIR` is the provider's own override;
 * the token is a placeholder nothing ever sends.
 */
export async function stubCodexSignIn(): Promise<string> {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'rooks-stub-codex-auth-'));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
  process.env.CODEX_AUTH_DIR = dir;
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * `getBackend(backend).buildSpawn(opts)` inside the launch seal the daemon opens around a real
 * launch: a provider plugin's services (`ctx.provider.mcp`, `scratch.mission`) answer only for a
 * mission whose launch is in progress. The token the seal issues is a placeholder.
 */
export async function buildUnderSeal(
  backend: string, opts: import('../../src/backends/types.js').BuildSpawnOpts,
): Promise<import('../../src/backends/types.js').SpawnResult> {
  const { getBackend } = await import('../../src/backends/index.js');
  const { openLaunchSeal, closeLaunchSeal } = await import('../../src/backends/launch-seal.js');
  const seal = openLaunchSeal(opts.missionId, backend, opts, () => `test-token-${opts.missionId}`);
  try {
    return await getBackend(backend).buildSpawn(opts);
  } finally {
    closeLaunchSeal(seal);
  }
}

/**
 * The same, for a test that wants to hand the dialect a profile of its own (a `ProfileRuntime` the
 * registry would not build: a provider block, a pinned program, a made-up env) instead of the one
 * the registry resolves for `backend`.
 */
export async function buildDialectUnderSeal(
  backend: string, dialectId: string, profile: import('../../src/backends/types.js').ProfileRuntime,
  opts: import('../../src/backends/types.js').BuildSpawnOpts,
): Promise<import('../../src/backends/types.js').SpawnResult> {
  const { getDialect } = await import('../../src/backends/registry.js');
  const { openLaunchSeal, closeLaunchSeal } = await import('../../src/backends/launch-seal.js');
  const dialect = getDialect(dialectId);
  if (!dialect || 'transport' in dialect) throw new Error(`no process dialect ${dialectId}`);
  const seal = openLaunchSeal(opts.missionId, backend, opts, () => `test-token-${opts.missionId}`);
  try {
    return await dialect.buildSpawn(opts, profile);
  } finally {
    closeLaunchSeal(seal);
  }
}

/**
 * The MCP servers an ACP agent's session is opened with (`session/new.mcpServers`), as the agent receives them:
 * the backend's real session driver on a scripted peer that answers the handshake and records the request,
 * inside the launch seal a real launch opens (the daemon swaps the token reference on the pipe).
 */
export async function acpSessionServers(
  backend: string, opts: import('../../src/backends/types.js').BuildSpawnOpts,
): Promise<Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }>> {
  const { PassThrough } = await import('node:stream');
  const { getBackend } = await import('../../src/backends/index.js');
  const { openLaunchSeal, closeLaunchSeal } = await import('../../src/backends/launch-seal.js');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let servers: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> = [];
  let pending = '';
  stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    for (let nl = pending.indexOf('\n'); nl !== -1; nl = pending.indexOf('\n')) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      const message = JSON.parse(line) as { id?: number; method?: string; params?: { mcpServers?: typeof servers } };
      if (message.id === undefined) continue;
      const result = message.method === 'initialize'
        ? { protocolVersion: 1, authMethods: [] }
        : message.method === 'session/new' ? { sessionId: 'probe' } : {};
      if (message.method === 'session/new') servers = message.params?.mcpServers ?? [];
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    }
  });
  const seal = openLaunchSeal(opts.missionId, backend, opts, () => 'test-token');
  const driver = getBackend(backend).openSession!({
    io: { stdin, stdout },
    spawn: opts,
    host: { emit: () => undefined, requestPermission: async () => ({ allow: true }) } as never,
    mcpEnv: { ROOKS_API_TOKEN: 'test-token' },
  });
  try {
    await driver.start();
    return servers;
  } finally {
    driver.close();
    closeLaunchSeal(seal);
  }
}
