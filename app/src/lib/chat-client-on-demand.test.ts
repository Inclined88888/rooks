/**
 * `ChatClient` is the heaviest module of the app (thread, composer, markdown,
 * rails). Outside the `/chat` route, whose page it is, every screen that shows
 * a chat loads it on demand (`next/dynamic`): `/bots` without a selected bot,
 * an empty multichat grid and the provider step of the setup never fetch it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The only files allowed a static import. `/chat` IS the conversation: loading
 * it on demand would only add a round trip before the page's first paint.
 */
const STATIC_ALLOWED: ReadonlySet<string> = new Set([join('app', 'chat', 'chat-route.tsx')]);

/** The screens that used to import it statically (TODO #517). */
const ON_DEMAND: readonly string[] = [
  join('plugins-client', 'bots', 'bots-page.tsx'),
  join('app', 'multichat', 'chat-slot.tsx'),
  join('app', 'setup', 'agent', 'page.tsx'),
];

const STATIC_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+['"][^'"]*\/chat-client['"]/m;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

test('no module but the /chat route imports ChatClient statically', () => {
  const offenders = sources(SRC)
    .map((path) => relative(SRC, path))
    .filter((file) => !STATIC_ALLOWED.has(file))
    .filter((file) => STATIC_IMPORT.test(readFileSync(join(SRC, file), 'utf8')));
  assert.deepEqual(offenders, [], `load ChatClient with next/dynamic instead: ${offenders.join(', ')}`);
});

test('the screens that show a chat on the side load it with next/dynamic', () => {
  for (const file of ON_DEMAND) {
    const source = readFileSync(join(SRC, file), 'utf8');
    assert.match(
      source,
      /const ChatClient = dynamic\(\(\) => import\('@\/app\/chat\/chat-client'\)\.then\(\(m\) => m\.ChatClient\), \{ ssr: false \}\);/,
      `${file}: ChatClient through next/dynamic`,
    );
  }
});

// The source check reads text; this one reads the module graph, so a re-export
// through another file (a barrel, a wrapper) would not slip through. A fresh
// process, because the test runner's own graph is not the page's.
test('loading those screens does not load chat-client', () => {
  const files = ON_DEMAND.map((file) => join('src', file));
  const code = [
    `for (const f of ${JSON.stringify(files)}) require(require('node:path').resolve(f));`,
    `const hit = Object.keys(require.cache).filter((k) => /chat[\\\\/]chat-client\\.tsx$/.test(k));`,
    'process.stdout.write(JSON.stringify(hit));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', code], {
    cwd: join(SRC, '..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
  assert.deepEqual(JSON.parse(out) as string[], []);
});
