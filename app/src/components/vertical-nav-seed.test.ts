import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { LayoutSeedsProvider } from './layout-seeds';
import { WorkspaceLayoutProvider } from './workspace-layout-provider';
import { VerticalNav } from './vertical-nav';
import { ThemeProvider } from './theme-provider';
import { WidgetHost } from './widget-host/widget-host';
import { navPinnedOf, resolvedNavScope, sharedNavScope, workspaceScope } from '@/lib/workspace-scope';

// Sources are compiled with the classic JSX runtime, which reads a global `React`.
(globalThis as { React?: typeof React }).React = React;

const OWNER = 'owner-a';

async function render(seed: unknown, seededFor: string | null = OWNER): Promise<string> {
  // Derived without `sharedNavScope`, which would remember it in this
  // document: a full reload starts with nothing remembered.
  const scope = `${await workspaceScope(OWNER, '', null)}.nav`;
  assert.equal(resolvedNavScope(OWNER), null, 'nothing derived on the client yet');
  const initial = { route: JSON.stringify(['/', null, null]), key: 'v2.view', sharedKey: 'v2.view.shared', owner: OWNER, project: null, view: '/' };
  const e = React.createElement;
  const nav = e(ThemeProvider, { children: e(WidgetHost, { children: e(VerticalNav) }) });
  const workspace = e(WorkspaceLayoutProvider, { initial, children: nav });
  const seeded = e(LayoutSeedsProvider, {
    seeds: seed === undefined ? {} : { [scope]: seed },
    navScope: seededFor ? { owner: seededFor, scope } : null,
    children: workspace,
  });
  const noop = () => {};
  const router: AppRouterInstance = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop };
  return renderToString(
    e(AppRouterContext.Provider, { value: router },
      e(PathnameContext.Provider, { value: '/' },
        e(SearchParamsContext.Provider, { value: new URLSearchParams() }, seeded))),
  );
}

function railClass(html: string): string {
  const m = /<nav[^>]*class="([^"]*rooks-nav-rail[^"]*)"/.exec(html);
  assert.ok(m, 'the rail is rendered');
  return m[1]!;
}

test('a pinned rail is painted expanded by the server render (full reload)', async () => {
  assert.match(railClass(await render({ pinned: true })), /\bw-56\b/);
});

test('an unpinned or unseeded rail is painted collapsed', async () => {
  assert.doesNotMatch(railClass(await render({ pinned: false })), /\bw-56\b/);
  assert.doesNotMatch(railClass(await render(undefined)), /\bw-56\b/);
  assert.doesNotMatch(railClass(await render(null)), /\bw-56\b/);
});

test('a seed derived for another account is ignored', async () => {
  assert.doesNotMatch(railClass(await render({ pinned: true }, 'owner-b')), /\bw-56\b/);
});

test('the seeded scope is the one the client derives', async () => {
  assert.equal(`${await workspaceScope(OWNER, '', null)}.nav`, await sharedNavScope('owner-a'));
});

test('navPinnedOf only reads a literal true', () => {
  assert.equal(navPinnedOf({ pinned: true }), true);
  assert.equal(navPinnedOf({ pinned: 'true' }), false);
  assert.equal(navPinnedOf(null), false);
  assert.equal(navPinnedOf([]), false);
});

test('the pinned gutter is reserved on desktop widths only', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'styles', 'globals.css'), 'utf8');
  const m = /@media \(min-width: 768px\) \{\s*:root\[data-nav-pinned\] \{\s*--rooks-nav-w: 224px;/.exec(css);
  assert.ok(m, 'data-nav-pinned reserves 224px under min-width: 768px');
  const layout = readFileSync(join(process.cwd(), 'src', 'app', 'layout.tsx'), 'utf8');
  assert.match(layout, /data-nav-pinned=\{navPinned \? '' : undefined\}/);
  assert.match(layout, /navScope=\{navScope\}/);
});
