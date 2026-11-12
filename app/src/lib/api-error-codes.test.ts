/**
 * The daemon and English agree on route error codes (TODO #829,
 * docs/I18N.md « Erreurs d'API »).
 *
 * The daemon names a code (`apiError('mission_not_found', …)`); the webview
 * shows `apiErrors.<code>`. A code with no English message would fall back to
 * the daemon's English in every language, silently; a message whose arguments
 * differ from the params the daemon sends would show `{name}` on screen. Both
 * are caught here, by reading `orchestrator/src` the way `locale-keys-used`
 * reads `app/src`.
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { DEFAULT_PATHS, lookup, readLocaleDictionary } from '../../scripts/build-locales.mjs';
import { parseMessage } from '../../scripts/check-locales.mjs';

const ORCHESTRATOR_SRC = join(process.cwd(), '..', 'orchestrator', 'src');
const english = readLocaleDictionary(join(DEFAULT_PATHS.sourceDir, 'en'));

/** Codes the webview itself produces or falls back on: no daemon call names them. */
const WEBVIEW_CODES = new Set(['unknown', 'http_status', 'module_unavailable', 'daemon_html_response']);

/** Where the helpers are defined: their code is a parameter, not a code. */
const HELPERS = new Set(['api-error.ts', 'plugins/contract/api-error.ts']);

type Use = { code: string; params: string[] | null; where: string };

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') out.push(...sourceFiles(path));
    } else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Names of an object literal's properties, `null` when one cannot be read (spread, computed). */
function literalKeys(node: ts.Expression): string[] | null {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const keys: string[] = [];
  for (const property of node.properties) {
    if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) keys.push(property.name.text);
    else return null;
  }
  return keys;
}

/** Every `apiError('code', msg, params?)` and `sendApiError(res, status, 'code', msg, params?)` with a literal code. */
function daemonUses(): { uses: Use[]; dynamic: string[] } {
  const uses: Use[] = [];
  const dynamic: string[] = [];
  for (const file of sourceFiles(ORCHESTRATOR_SRC)) {
    if (HELPERS.has(relative(ORCHESTRATOR_SRC, file).split(sep).join('/'))) continue;
    const text = readFileSync(file, 'utf8');
    if (!text.includes('apiError(') && !text.includes('sendApiError(')) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && (node.expression.text === 'apiError' || node.expression.text === 'sendApiError')) {
        const offset = node.expression.text === 'sendApiError' ? 2 : 0;
        const codeArg = node.arguments[offset];
        const where = `${relative(ORCHESTRATOR_SRC, file).split(sep).join('/')}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        if (codeArg && ts.isStringLiteral(codeArg)) {
          const paramsArg = node.arguments[offset + 2];
          uses.push({ code: codeArg.text, params: paramsArg ? literalKeys(paramsArg) : [], where });
        } else if (codeArg) dynamic.push(where);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { uses, dynamic };
}

const { uses, dynamic } = daemonUses();
const englishCodes = Object.keys((english as { apiErrors?: Record<string, unknown> }).apiErrors ?? {});

test('the scan finds the daemon calls', () => {
  assert.ok(uses.length > 200, `only ${uses.length} apiError calls found — did the helper move?`);
});

test('every code the daemon sends has an English message', () => {
  const missing = uses.filter((use) => typeof lookup(english, `apiErrors.${use.code}`) !== 'string');
  assert.deepEqual(missing.map((use) => `${use.where} → apiErrors.${use.code}`), [],
    'add these codes to app/src/locales/en/apiErrors.json');
});

test('every message takes exactly the params the daemon sends', () => {
  const wrong: string[] = [];
  for (const use of uses) {
    const message = lookup(english, `apiErrors.${use.code}`);
    if (typeof message !== 'string' || use.params === null) continue;
    const args = [...parseMessage(message, 'en').args].sort();
    const params = [...use.params].sort();
    if (args.join() !== params.join()) wrong.push(`${use.where} sends {${params.join(', ')}}, apiErrors.${use.code} reads {${args.join(', ')}}`);
  }
  assert.deepEqual(wrong, []);
});

test('the code is a literal wherever it can be: a computed code escapes this check', () => {
  assert.deepEqual(dynamic, []);
});

test('no English message is left without a daemon call or a webview use', () => {
  const sent = new Set(uses.map((use) => use.code));
  assert.deepEqual(englishCodes.filter((code) => !sent.has(code) && !WEBVIEW_CODES.has(code)), [],
    'remove these keys, or list them in WEBVIEW_CODES with the code that produces them');
});
