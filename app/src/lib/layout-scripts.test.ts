import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext, Script } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { FIRST_RUN_ALLOWED, FIRST_RUN_SCHEME_KEY, schemeFollowsSystem } from './first-run-gate';
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

// First-run opens light for everyone, whatever the OS: the pre-paint script
// must not consult the OS at all, and outside first-run it must leave the
// server's class alone.
test('server-rendered layout scripts parse and paint the onboarding light whatever the OS', () => {
  const scripts = layoutScripts().map((code) => new Script(code));
  for (const pathname of ['/', '/agents', '/chat', '/login', '/login///', '/setup', '/setup/team/', '/setup-other', "/projects/l'été ` </script>"]) {
    for (const light of [true, false]) {
      const classes = new Set(['dark']);
      let osAsked = false;
      const context = {
        location: { pathname },
        matchMedia: () => { osAsked = true; return { matches: light }; },
        document: { documentElement: { classList: {
          toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
        } } },
      };
      for (const script of scripts) script.runInNewContext(context);
      assert.equal(osAsked, false, pathname);
      if (schemeFollowsSystem(pathname)) {
        assert.equal(classes.has('light'), true, pathname);
        assert.equal(classes.has('dark'), false, pathname);
      } else {
        // Outside first-run the script returns early — leaves the server's class.
        assert.equal(classes.has('dark'), true, pathname);
        assert.equal(classes.has('light'), false, pathname);
      }
    }
  }
});

test('a scheme picked on the onboarding switch wins over the light default, on the onboarding only', () => {
  const scripts = layoutScripts().map((code) => new Script(code));
  for (const pathname of ['/onboarding', '/login', '/chat']) {
    for (const [stored, light, expected] of [['dark', true, 'dark'], ['light', false, 'light'], ['light', true, 'light'], ['auto', true, 'light'], [null, true, 'light']] as const) {
      const classes = new Set(['dark']);
      const context = {
        location: { pathname },
        matchMedia: () => ({ matches: light }),
        sessionStorage: { getItem: (key: string) => (key === FIRST_RUN_SCHEME_KEY ? stored : null) },
        document: { documentElement: { classList: {
          toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
        } } },
      };
      for (const script of scripts) script.runInNewContext(context);
      const want = schemeFollowsSystem(pathname) ? expected : 'dark';
      assert.equal(classes.has('light'), want === 'light', `${pathname} ${String(stored)}`);
      assert.equal(classes.has('dark'), want === 'dark', `${pathname} ${String(stored)}`);
    }
  }
});
