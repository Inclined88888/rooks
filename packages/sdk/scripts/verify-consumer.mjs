#!/usr/bin/env node
/**
 * Proves the SDK works for a plugin author OUTSIDE this repository, without
 * installing anything:
 *
 *   1. builds `dist/` into a temporary directory;
 *   2. stages the package as a consumer finds it — `package.json` + `dist/`, and
 *      nothing of `orchestrator/src` — under `node_modules/@rooks/sdk` of a
 *      temporary project that has no other link to the repository;
 *   3. installs the package's type dependencies the way npm would
 *      (`@types/express` and what it pulls, `@types/node`), copied from the
 *      repository's own `node_modules`: nothing is downloaded;
 *   4. copies the provider and dictation examples there and type-checks them with
 *      `moduleResolution: NodeNext`, the mode that reads `exports`;
 *   5. type-checks EVERY example's host and browser half (`checkJs`) against the
 *      main entry `@rooks/sdk` and `@rooks/sdk/ui`, with declaration
 *      checking on, plus a TypeScript consumer that names the context, the
 *      manifest and the router: a broken `.d.ts` or a missing type dependency
 *      fails here;
 *   6. imports the main entry at runtime: `PLUGIN_API_VERSION` (and
 *      `apiVersion`) is its only value, and equals the contract's;
 *   7. runs the examples' own conformance tests from that project;
 *   8. checks that the built package reaches nothing but its own files, `node:`
 *      builtins and (declarations only) `express`, and holds no module of the
 *      daemon outside the pinned closure.
 *
 *   node scripts/verify-consumer.mjs [--keep]
 *
 * Exit code 0 = every step passed. `--keep` leaves the temporary project in
 * place and prints its path.
 *
 * The examples are JavaScript written by plugin authors: `noImplicitAny` and
 * `useUnknownInCatchVariables` stay off for them (an untyped helper or a
 * `catch (error)` is ordinary JS, not a contract fault), every other `strict`
 * check is on. Each example types its `apply(ctx)` with the SDK context, so
 * the check reads the contract rather than an implicit `any`. React is a stub
 * typed `any`: the SDK has no React dependency (`ui.d.ts`), and React's own
 * typings say nothing about the contract.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..');
const REPO = resolve(PACKAGE, '..', '..');
const keep = process.argv.includes('--keep');

const EXAMPLES = ['plugin-provider', 'plugin-provider-cursor', 'plugin-remote-backend', 'plugin-dictation'];
/** Modules the declarations may name outside the package: the type dependency of `ctx.router()`. */
const DECLARATION_PEERS = new Set(['express']);
/** Daemon modules that must never ship, whatever imports them (same list as `contract-imports.test.ts`). */
const FORBIDDEN_IN_DIST = [/orchestrator\/src\/db(\.|\/)/, /\/license\//, /\/secrets\/(?!redact\.)/, /\/host\//, /\/kernel\//, /cordis/i, /better-sqlite3/, /\/zod\//];

const failures = [];
const step = (label) => console.log(`\n── ${label}`);
const fail = (message) => { failures.push(message); console.error(`✗ ${message}`); };

function compiler() {
  const candidates = [process.env.ROOKS_TSC, join(REPO, 'orchestrator', 'node_modules', 'typescript', 'bin', 'tsc')].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No TypeScript compiler found (set ROOKS_TSC).');
  return found;
}

function run(label, command, args, cwd, timeoutMs) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status ?? result.signal})`);
    process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    return false;
  }
  console.log(`✓ ${label}`);
  return true;
}

/** Every file under `dir` whose name ends with `suffix`. */
function filesEnding(dir, suffix) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(suffix))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

/**
 * Copies `name` and, recursively, its `dependencies` from the repository's
 * `orchestrator/node_modules` into `nodeModules`, flat, as npm lays them out.
 */
function installFromRepository(name, nodeModules, seen = new Set()) {
  if (seen.has(name)) return;
  seen.add(name);
  const source = join(REPO, 'orchestrator', 'node_modules', ...name.split('/'));
  if (!existsSync(join(source, 'package.json'))) throw new Error(`${name} is not in orchestrator/node_modules: cannot stage it`);
  cpSync(source, join(nodeModules, ...name.split('/')), { recursive: true, dereference: true });
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) installFromRepository(dependency, nodeModules, seen);
}

/** Examples that have a host or browser half to check. */
function examplesWithCode() {
  return readdirSync(join(REPO, 'examples'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(REPO, 'examples', e.name, 'lib')))
    .map((e) => e.name)
    .sort();
}

/** The contract's API version, read from its source. */
function contractApiVersion() {
  const source = readFileSync(join(REPO, 'orchestrator', 'src', 'plugins', 'contract', 'manifest.ts'), 'utf8');
  const match = /export const PLUGIN_API_VERSION\s*=\s*(\d+)/.exec(source);
  if (!match) throw new Error('PLUGIN_API_VERSION not found in contract/manifest.ts');
  return Number(match[1]);
}

const work = mkdtempSync(join(tmpdir(), 'rooks-sdk-consumer-'));
try {
  step('build');
  const dist = build(join(work, 'dist'));

  step('stage the package as a consumer finds it');
  const consumer = join(work, 'consumer');
  const staged = join(consumer, 'node_modules', '@rooks', 'sdk');
  mkdirSync(staged, { recursive: true });
  const sdkManifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
  cpSync(join(PACKAGE, 'package.json'), join(staged, 'package.json'));
  // What `files` publishes, nothing more: `dist/` is the whole package.
  if (JSON.stringify(sdkManifest.files) !== JSON.stringify(['dist'])) fail(`package.json "files" is ${JSON.stringify(sdkManifest.files)}, expected ["dist"]`);
  cpSync(dist, join(staged, 'dist'), { recursive: true });
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));

  step('install the type dependencies as npm would');
  const nodeModules = join(consumer, 'node_modules');
  for (const dependency of Object.keys(sdkManifest.dependencies ?? {})) installFromRepository(dependency, nodeModules);
  // An optional peer the author is expected to have: the examples run on node.
  installFromRepository('@types/node', nodeModules);
  console.log(`✓ ${readdirSync(join(nodeModules, '@types')).length} @types packages staged`);
  for (const example of EXAMPLES) {
    cpSync(join(REPO, 'examples', example), join(consumer, example), { recursive: true });
  }
  // A provider written in TypeScript against the published types only: the
  // behaviour comes from `ctx.provider.runtime`, never from the package.
  mkdirSync(join(consumer, 'provider-ts'), { recursive: true });
  writeFileSync(join(consumer, 'provider-ts', 'provider.ts'), [
    "import type { Dialect, NormalizedEvent, ProviderDefinition, ProviderPluginContext, ProviderRuntime } from '@rooks/sdk/provider';",
    "import { bindDialect, createProviderContext, lineProviderChecks } from '@rooks/sdk/testing';",
    '',
    'export function createDialect(runtime: ProviderRuntime) {',
    '  const { events, jsonLines } = runtime;',
    '  return {',
    "    id: 'ts-consumer', defaultCmd: 'ts-cli', persistentProcess: false, finishMissionOnExit: false,",
    "    sessionResumable: true, sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none',",
    '    hostedConnectors: false,',
    '    async buildSpawn(opts, profile) { return { cmd: profile.cmd, args: [opts.message], cwd: opts.cfg.cwd, initialStdin: null }; },',
    '    writeUserInput() {},',
    '    parseLine(line): NormalizedEvent[] {',
    '      const row = jsonLines.parseJsonObjectLine(line);',
    '      if (!row) return [];',
    "      return row.type === 'init' ? [events.systemInitEvent({ sessionId: String(row.id) })] : [events.resultSuccessEvent()];",
    '    },',
    '    extractSessionId: events.extractInitSessionId,',
    '  } satisfies Dialect;',
    '}',
    '',
    'export function apply(ctx: ProviderPluginContext): void {',
    "  ctx.backends.registerDialect('ts-consumer', createDialect(ctx.provider.runtime));",
    '}',
    '',
    'const ctx = createProviderContext();',
    'apply(ctx);',
    'export const problems: string[] = ctx.provider.runtime.check.dialectProblems(ctx.registered.dialect(\'ts-consumer\'));',
    'export const framed: string = ctx.provider.runtime.jsonLines.encodeJsonLine({ ok: true });',
    "export const provider = bindDialect(ctx.registered.dialect('ts-consumer'), { id: 'ts-consumer' });",
    'export const checks = lineProviderChecks(provider, { transcript: [], sessionId: "x", cmd: "ts-cli", model: "m" }, { cwd: "." });',
    'export type Definition = ProviderDefinition;',
    '',
  ].join('\n'));

  step('type-check as a plugin author outside the repository (NodeNext)');
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, allowJs: true, checkJs: false,
      noEmit: true, skipLibCheck: false, types: ['node'],
    },
    include: [
      ...EXAMPLES.flatMap((e) => [`${e}/lib/*.js`, `${e}/test/*.mjs`]),
      'provider-ts/*.ts',
    ],
  }, null, 2));
  run('tsc', process.execPath, [compiler(), '-p', 'tsconfig.json'], consumer, 180_000);

  step('type-check every example against @rooks/sdk (checkJs)');
  const mainExamples = examplesWithCode();
  for (const example of mainExamples) {
    const target = join(consumer, 'main', example);
    mkdirSync(target, { recursive: true });
    cpSync(join(REPO, 'examples', example, 'lib'), join(target, 'lib'), { recursive: true });
    cpSync(join(REPO, 'examples', example, 'package.json'), join(target, 'package.json'));
  }
  mkdirSync(join(consumer, 'main', 'stubs'), { recursive: true });
  writeFileSync(join(consumer, 'main', 'stubs', 'react.d.ts'), "declare module 'react' { const React: any; export default React; }\n");
  // A plugin written in TypeScript against the main entry: values, the manifest,
  // both contexts, and a router that must not have collapsed to `any`.
  mkdirSync(join(consumer, 'main', 'plugin-ts'), { recursive: true });
  writeFileSync(join(consumer, 'main', 'plugin-ts', 'plugin.ts'), [
    "import { PLUGIN_API_VERSION, apiVersion } from '@rooks/sdk';",
    "import type { ClientContext, ClientPlugin, PluginContext, PluginManifest, PluginPermission } from '@rooks/sdk';",
    "import { Slot, createTranslator } from '@rooks/ui';",
    '',
    'type IsAny<T> = 0 extends 1 & T ? true : false;',
    "export const routerIsTyped: IsAny<ReturnType<PluginContext['router']>> = false;",
    'export const version: number = PLUGIN_API_VERSION + apiVersion;',
    "const permissions: PluginPermission[] = ['storage', 'events:subscribe'];",
    'export const manifest: Pick<PluginManifest, \'apiVersion\' | \'permissions\'> = { apiVersion: PLUGIN_API_VERSION, permissions };',
    '',
    'export function apply(ctx: PluginContext): void {',
    '  const router = ctx.router();',
    "  router.get('/hello', (_request, response) => { response.json({ user: ctx.user()?.id ?? null }); });",
    "  ctx.events.on('task_created', (event) => { ctx.log.info(event.task.id); });",
    '}',
    '',
    "const t = createTranslator({ en: { hello: 'Hello' } });",
    'export const client: ClientPlugin = {',
    '  apply(context: ClientContext) {',
    "    return context.slots.register({ slot: 'cockpit.widget', key: 'ts', widget: { title: t('hello') } }, () => Slot);",
    '  },',
    '};',
    '',
  ].join('\n'));
  writeFileSync(join(consumer, 'main', 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'],
      strict: true, noImplicitAny: false, useUnknownInCatchVariables: false,
      allowJs: true, checkJs: true, noEmit: true, skipLibCheck: false,
      types: ['node', '@rooks/sdk/ui'],
    },
    include: [...mainExamples.map((e) => `${e}/lib/*.js`), 'plugin-ts/*.ts', 'stubs/*.d.ts'],
  }, null, 2));
  run(`tsc --checkJs (${mainExamples.length} examples + a TypeScript plugin)`, process.execPath, [compiler(), '-p', join('main', 'tsconfig.json')], consumer, 180_000);

  step('the main entry at runtime');
  const expectedVersion = contractApiVersion();
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const m = await import('@rooks/sdk'); console.log(JSON.stringify({ keys: Object.keys(m).sort(), version: m.PLUGIN_API_VERSION, alias: m.apiVersion, error: m.apiError('not_found', 'not found', { id: 'x' }) }));"],
  { cwd: consumer, encoding: 'utf8', timeout: 30_000 });
  if (probe.status !== 0) fail(`importing @rooks/sdk failed: ${probe.stderr}`);
  else {
    const seen = JSON.parse(probe.stdout.trim());
    // The route error helper (TODO #829) is the only behaviour of the main entry: pure, daemon-free.
    const expectedKeys = ['API_ERROR_CODE', 'PLUGIN_API_VERSION', 'apiError', 'apiVersion'];
    if (JSON.stringify(seen.keys) !== JSON.stringify(expectedKeys)) fail(`@rooks/sdk exports the values ${seen.keys.join(', ')}; only ${expectedKeys.join(', ')} are expected`);
    else if (seen.version !== expectedVersion || seen.alias !== expectedVersion) fail(`@rooks/sdk says API ${seen.version}/${seen.alias}, the contract ${expectedVersion}`);
    else if (JSON.stringify(seen.error) !== JSON.stringify({ error: 'not found', code: 'not_found', params: { id: 'x' } })) fail(`apiError built ${JSON.stringify(seen.error)}`);
    else console.log(`✓ PLUGIN_API_VERSION = apiVersion = ${expectedVersion}, apiError runs, nothing else`);
  }

  step('run the examples\' conformance tests from the consumer project');
  for (const example of EXAMPLES) {
    run(`${example} conformance`, process.execPath, ['--test', '--test-timeout=60000', `${example}/test/conformance.test.mjs`], consumer, 120_000);
  }

  step('the built package refuses the sign-in folder of a product backend');
  writeFileSync(join(consumer, 'reserved-dirs.mjs'), [
    "import { providerRuntime } from '@rooks/sdk/testing';",
    'const check = providerRuntime.check.declarationProblems;',
    "const refused = check({ credentialDirs: ['.claude'] }, 'acme');",
    "if (refused.length !== 1 || !/`claude` backend/.test(refused[0])) throw new Error(`.claude accepted: ${JSON.stringify(refused)}`);",
    "const own = check({ credentialDirs: ['.acme'] }, 'acme');",
    "if (own.length !== 0) throw new Error(`.acme refused: ${JSON.stringify(own)}`);",
  ].join('\n'));
  run('`.claude` refused to a third party, `.acme` allowed', process.execPath, ['reserved-dirs.mjs'], consumer, 60_000);

  step('the built package reaches nothing but itself, node: and its type dependency');
  const distRoot = join(staged, 'dist');
  const importRe = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^import\s*['"]([^'"]+)['"]/gm;
  for (const file of filesEnding(distRoot, '')) {
    const path = relative(distRoot, file).split(sep).join('/');
    const forbidden = FORBIDDEN_IN_DIST.find((re) => re.test(path));
    if (forbidden) fail(`dist/${path} is a daemon module outside the pinned closure (${forbidden})`);
  }
  let checked = 0;
  for (const file of [...filesEnding(distRoot, '.js'), ...filesEnding(distRoot, '.d.ts')]) {
    const declaration = file.endsWith('.d.ts');
    // Comments are kept by the compiler and may quote an import statement as documentation.
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const match of source.matchAll(importRe)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier.startsWith('node:')) continue;
      // The test kit's declarations name the package's own sub-paths.
      if (declaration && (DECLARATION_PEERS.has(specifier) || specifier.startsWith('@rooks/sdk/'))) continue;
      if (!specifier.startsWith('.')) { fail(`${relative(distRoot, file)} imports the bare module \`${specifier}\``); continue; }
      const target = resolve(dirname(file), specifier);
      const onDisk = declaration ? target.replace(/\.js$/, '.d.ts') : target;
      if (!target.startsWith(distRoot + sep) || !existsSync(onDisk)) fail(`${relative(distRoot, file)} imports \`${specifier}\`, which is not in the package`);
      checked += 1;
    }
  }
  console.log(`✓ ${checked} imports checked`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (keep) console.log(`\nkept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s).`);
  process.exit(1);
}
console.log('\nThe SDK works for a plugin author outside the repository.');
