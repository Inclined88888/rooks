/**
 * Every shipped backend profile has a logo.
 *
 * `backend.brand` is a key into `BRAND_ICONS`; a key with no path degrades to
 * a letter pill, silently — that is how `opencode` and `nous` shipped without
 * a logo in the Quota widget and the backends settings. The product's profiles
 * live in its official provider plugins (`orchestrator/official-providers/<pkg>/lib`),
 * one `export const <NAME>_PROFILE = { … }` each, and are read with the TypeScript
 * parser (the two packages stay independent at runtime, but a test may read the
 * repository): no regex on the source, so the guard depends on neither indentation
 * nor field order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { BRAND_KEYS, BrandMark, isPicture } from '../components/brand-mark';

// BrandMark predates the automatic JSX runtime and expects `React` in scope.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const OFFICIAL_PROVIDERS = fileURLToPath(new URL('../../../orchestrator/official-providers', import.meta.url));

interface ProfileEntry {
  id: string;
  brand: string | null;
}

/** String value of the property `name` of an object literal, or null. */
function stringProp(obj: ts.ObjectLiteralExpression, name: string): string | null {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (key !== name) continue;
    return ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : null;
  }
  return null;
}

/** One entry per top-level `const <NAME>_PROFILE = { … }` of a module. A profile
 *  without `brand` is reported with `brand: null`, never skipped. */
function parseProfiles(src: string): ProfileEntry[] {
  const file = ts.createSourceFile('profile.js', src, ts.ScriptTarget.Latest, true);
  const entries: ProfileEntry[] = [];
  file.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.name.text.endsWith('_PROFILE') || !decl.initializer) continue;
      // Unwrap `{…} as X` / `{…} satisfies X`.
      let init: ts.Expression = decl.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) {
        init = init.expression;
      }
      assert.ok(ts.isObjectLiteralExpression(init), `${decl.name.text} is not an object literal`);
      entries.push({ id: stringProp(init, 'id') ?? '?', brand: stringProp(init, 'brand') });
    }
  });
  return entries;
}

/** Every profile the official provider plugins ship. Throws when none is found, so a moved table cannot pass silently. */
function shippedProfiles(): ProfileEntry[] {
  const entries = readdirSync(OFFICIAL_PROVIDERS).flatMap((pkg) => {
    const lib = join(OFFICIAL_PROVIDERS, pkg, 'lib');
    let names: string[];
    try { names = readdirSync(lib); } catch { return []; }
    return names.filter((name) => name.endsWith('.js')).flatMap((name) => parseProfiles(readFileSync(join(lib, name), 'utf8')));
  });
  assert.ok(entries.length > 0, 'no `*_PROFILE` found under orchestrator/official-providers');
  return entries;
}

/** Profiles whose brand is missing or has no logo. */
function withoutLogo(entries: ProfileEntry[]): string[] {
  return entries.filter((e) => !e.brand || !BRAND_KEYS.includes(e.brand)).map((e) => e.id);
}

const shipped = shippedProfiles();

test('every shipped profile is parsed, with an id', () => {
  assert.ok(shipped.every((e) => e.id !== '?'));
});

test('every shipped profile declares a brand that resolves to a logo', () => {
  assert.deepEqual(withoutLogo(shipped), [], 'profiles without a resolved logo');
});

test('a profile without a brand, or with an unknown one, fails the guard', () => {
  const bad = parseProfiles(
    "export const A_PROFILE = { id: 'a' }; export const B_PROFILE = { id: 'b', brand: 'nope' }; export const C_PROFILE = { id: 'c', brand: 'nous' };",
  );
  assert.deepEqual(withoutLogo(bad), ['a', 'b']);
});

test('tab indentation and another field order are read correctly', () => {
  const odd = parseProfiles(
    "export const A_PROFILE = {\n\t\tlabel: 'A',\n\t\tbrand: 'nous',\n\t\tid: 'a',\n\t};\nexport const B_PROFILE = { brand: 'nope', 'id': 'b' };\nexport const C_PROFILE = {\n\t\t\tid: 'c',\n\t};\n",
  );
  assert.deepEqual(odd, [
    { id: 'a', brand: 'nous' },
    { id: 'b', brand: 'nope' },
    { id: 'c', brand: null },
  ]);
  assert.deepEqual(withoutLogo(odd), ['b', 'c']);
});

test('a module without a profile yields none, and a profile that is not a literal fails loudly', () => {
  assert.deepEqual(parseProfiles('export const OTHER = {};'), []);
  assert.throws(() => parseProfiles('export const X_PROFILE = make();'), /not an object literal/);
});

test('the profiles of every official provider are read', () => {
  const ids = shipped.map(({ id }) => id);
  for (const id of ['grok', 'copilot', 'opencode', 'hermes', 'pi']) assert.ok(ids.includes(id), id);
});

test('a shipped brand renders an svg, not the letter pill', () => {
  for (const { id, brand } of shipped) {
    const html = renderToStaticMarkup(React.createElement(BrandMark, { brand: brand ?? '', className: 'size-4' }));
    assert.match(html, /^<svg/, `${id} fell back to the letter pill`);
  }
});

test('a logo a provider declared is drawn as an image; nothing that would be fetched is', () => {
  const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
  assert.equal(isPicture(svg), true);
  assert.equal(isPicture('/api/uploads/backends/abc.png'), true);
  for (const refused of ['https://evil.example/logo.png', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml,<svg/>', 'javascript:alert(1)', '🦊']) {
    assert.equal(isPicture(refused), false, refused);
  }
  const html = renderToStaticMarkup(React.createElement(BrandMark, { icon: svg, className: 'size-4' }));
  assert.match(html, /<img[^>]+src="data:image\/svg\+xml;base64,PHN2Zy8\+"/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(BrandMark, { icon: 'https://evil.example/logo.png' })), /<img/);
});
