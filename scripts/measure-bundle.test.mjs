import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { layoutChain, measure, modulesOf, packageOf, routeFiles, retainedSizes, routeOf, whyChain } from './measure-bundle.mjs';

test('route groups and the page suffix vanish from the URL', () => {
  assert.equal(routeOf('/(main)/page'), '/');
  assert.equal(routeOf('/(main)/settings/page'), '/settings');
  assert.equal(routeOf('/chat/page'), '/chat');
  assert.equal(routeOf('/confirm-email/[token]/page'), '/confirm-email/[token]');
});

test('a page is wrapped by every layout above it, outermost first', () => {
  const entries = new Set(['/layout', '/(main)/layout', '/(main)/missions/page', '/chat/page']);
  assert.deepEqual(layoutChain('/(main)/missions/page', entries), ['/layout', '/(main)/layout']);
  assert.deepEqual(layoutChain('/chat/page', entries), ['/layout']);
});

test('a file shared by a page and its layouts counts once, CSS never', () => {
  const files = routeFiles({
    pages: {
      '/layout': ['static/chunks/webpack.js', 'static/chunks/a.js', 'static/css/app.css'],
      '/(main)/layout': ['static/chunks/webpack.js', 'static/chunks/b.js'],
      '/(main)/x/page': ['static/chunks/webpack.js', 'static/chunks/a.js', 'static/chunks/x.js'],
    },
  });
  assert.deepEqual(files['/layout'], ['static/chunks/webpack.js', 'static/chunks/a.js']);
  assert.deepEqual(files['/(main)/x/page'].sort(), ['static/chunks/a.js', 'static/chunks/b.js', 'static/chunks/webpack.js', 'static/chunks/x.js']);
  assert.equal(files['/(main)/layout'], undefined, 'a nested layout is not a route');
});

test('sizes come from the dist dir, a missing file is reported not thrown', () => {
  const dist = mkdtempSync(join(tmpdir(), 'measure-bundle-'));
  mkdirSync(join(dist, 'static', 'chunks'), { recursive: true });
  writeFileSync(join(dist, 'static', 'chunks', 'a.js'), 'x'.repeat(4096));
  writeFileSync(join(dist, 'app-build-manifest.json'), JSON.stringify({
    pages: { '/layout': ['static/chunks/a.js'], '/chat/page': ['static/chunks/a.js', 'static/chunks/gone.js'] },
  }));
  const { rows, chunks } = measure(dist);
  assert.equal(rows[0].route, '(root layout)');
  assert.equal(rows[0].raw, 4096);
  assert.ok(rows[0].gzip < 4096);
  const chat = rows.find((r) => r.route === '/chat');
  assert.equal(chat.raw, 4096);
  assert.equal(chat.missing, 1);
  assert.equal(chunks.length, 1, 'each file read once');
});

test('modules group by package, scoped ones keep their scope', () => {
  assert.equal(packageOf('../node_modules/lucide-react/dist/esm/icons/x.js'), 'lucide-react');
  assert.equal(packageOf('./node_modules/@radix-ui/react-menu/dist/index.mjs'), '@radix-ui/react-menu');
  assert.equal(packageOf('./src/lib/markdown.ts + 3 modules'), 'src/lib/markdown.ts');
  const top = modulesOf(['a.js', 'b.js'], {
    'a.js': [{ name: './node_modules/marked/lib/marked.esm.js', size: 10 }, { name: './src/x.ts', size: 3 }],
    'b.js': [{ name: './node_modules/marked/lib/other.js', size: 5 }],
  });
  assert.deepEqual(top, [{ name: 'marked', size: 15 }, { name: 'src/x.ts', size: 3 }]);
});

test('why finds the shortest static chain up to an entry', () => {
  const stats = {
    'a.js': [
      { name: './src/app/layout.tsx', size: 1, importers: [] },
      { name: './src/components/editor.tsx', size: 1, importers: ['./src/app/layout.tsx', './src/app/edit/edit-client.tsx'] },
      { name: './src/app/edit/edit-client.tsx', size: 1, importers: ['./src/app/edit/page.tsx'] },
      { name: './src/app/edit/page.tsx', size: 1, importers: [] },
    ],
    'b.js': [
      { name: './node_modules/lucide-react/dist/esm/icons/index.js', size: 1, importers: ['./src/components/editor.tsx'] },
      { name: './src/x.ts', size: 1, importers: ['./src/y.ts'] },
      { name: './src/y.ts', size: 1, importers: ['./src/x.ts'] },
    ],
  };
  assert.deepEqual(whyChain('icons/index', stats), [
    './node_modules/lucide-react/dist/esm/icons/index.js',
    './src/components/editor.tsx',
    './src/app/layout.tsx',
  ]);
  assert.deepEqual(whyChain('src/x.ts', stats), ['./src/x.ts'], 'a cycle with no entry ends where it started');
  assert.deepEqual(whyChain('nowhere', stats), []);
});

test('retained = what only that module holds in the layout', () => {
  const stats = {
    'l.js': [
      { name: './src/a.tsx', size: 10, importers: [''] },
      { name: './src/b.tsx', size: 20, importers: [] },
      { name: './src/heavy.ts', size: 100, importers: ['./src/a.tsx'] },
      { name: './src/shared.ts', size: 5, importers: ['./src/a.tsx', './src/b.tsx'] },
    ],
    'lazy.js': [{ name: './src/lazy-only.ts', size: 1000, importers: ['./src/a.tsx'] }],
  };
  assert.deepEqual(retainedSizes(['l.js'], stats), [
    { name: './src/a.tsx', size: 110 },
    { name: './src/heavy.ts', size: 100 },
    { name: './src/b.tsx', size: 20 },
    { name: './src/shared.ts', size: 5 },
  ], 'shared holds only itself; lazy-only is not in the layout');
});
