import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext, Script } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { FIRST_RUN_ALLOWED, FIRST_RUN_SCHEME_KEY } from './first-run-gate';
import { PLATFORM_MODULES } from './plugin-host/modules';

// Compile the actual JSX nodes: inspecting the template's source text misses
// escaping lost when the server evaluates it before sending HTML.
function layoutScripts(): string[] {
  const source = ts.createSourceFile('layout.tsx', readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scripts: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'script') {
      const compiled = ts.transpileModule(`(${node.getText(source)})`, {
        compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const element = runInNewContext(compiled, { React, FIRST_RUN_ALLOWED, FIRST_RUN_SCHEME_KEY, PLATFORM_MODULES }) as React.ReactElement;
      const html = renderToStaticMarkup(element);
      const match = /^<script([^>]*)>([\s\S]*)<\/script>$/.exec(html);
      assert.ok(match, 'each inline script must survive HTML serialization');
      if (match[1]?.includes('type="importmap"')) JSON.parse(match[2]!);
      else scripts.push(match[2]!);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(scripts.length > 0, 'exercise the executable root layout scripts');
  return scripts;
}

// First paint is light. System follows the OS. Nothing else asks the OS.
test('server-rendered layout scripts paint light until Settings follows the system', () => {
  const scripts = layoutScripts().map((code) => new Script(code));
  for (const pathname of ['/', '/agents', '/chat', '/login', '/onboarding', '/setup']) {
    for (const light of [true, false]) {
      const classes = new Set(['dark']);
      let osAsked = false;
      const context = {
        location: { pathname },
        window: { matchMedia: () => { osAsked = true; return { matches: !light }; } },
        matchMedia: () => { osAsked = true; return { matches: !light }; },
        localStorage: { getItem: () => null },
        document: { documentElement: { classList: {
          toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
        } } },
      };
      for (const script of scripts) script.runInNewContext(context);
      assert.equal(osAsked, false, pathname);
      assert.equal(classes.has('light'), true, pathname);
      assert.equal(classes.has('dark'), false, pathname);
    }
  }
});

test('system mode paints the operating system, and a stored light stays light', () => {
  const scripts = layoutScripts().map((code) => new Script(code));
  for (const [mode, osDark, want] of [['system', true, 'dark'], ['system', false, 'light'], ['light', true, 'light'], [null, true, 'light']] as const) {
    const classes = new Set<string>();
    const context = {
      location: { pathname: '/bots' },
      window: { matchMedia: () => ({ matches: osDark }) },
      matchMedia: () => ({ matches: osDark }),
      localStorage: { getItem: (key: string) => (key === 'rooks.appearance.schemeMode' ? mode : null) },
      document: { documentElement: { classList: {
        toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
      } } },
    };
    for (const script of scripts) script.runInNewContext(context);
    assert.equal(classes.has('dark'), want === 'dark', `${String(mode)} osDark=${osDark}`);
    assert.equal(classes.has('light'), want === 'light', `${String(mode)} osDark=${osDark}`);
  }
});
