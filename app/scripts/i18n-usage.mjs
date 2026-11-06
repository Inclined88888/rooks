/**
 * Where the interface code uses its messages (docs/I18N.md, "Contributor
 * tooling"). Read by two tools:
 *
 *  - `src/lib/locale-keys-used.test.ts`: every key the code names literally
 *    exists in English, and every call passes the arguments its English
 *    message names;
 *  - `scripts/i18n-report.mjs` (repository root): which English messages no
 *    code seems to read.
 *
 * Text, not a type checker: a call is `t('some.key'` or `t("some.key"`, in a
 * file that imports the product's `t` (`@/lib/i18n`, `./i18n`, `@timon/ui`).
 * A file with a translator of its own (a plugin's `createTranslator`) is left
 * out: its keys are not the product's. A key built at run time
 * (`` t(`kind.${x}`) ``) cannot be checked; its fixed prefix is recorded, so
 * the report does not call every message under it unused.
 *
 * Pure node, no dependency: the report runs from the repository root, where
 * the app's packages do not resolve.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CODE_DIR = join(appDir, 'src');

const CODE_FILE = /\.(ts|tsx|mts|cts)$/;
const NOT_CODE = /\.test\.[cm]?tsx?$|\.d\.ts$/;
const IMPORTS_T = /import\s*(?:type\s+)?\{[^}]*\bt\b[^}]*\}\s*from\s*['"](?:@\/lib\/i18n|\.{1,2}\/(?:lib\/)?i18n|@timon\/ui)['"]/;
const LITERAL_CALL = /(?<![\w.$])t\(\s*(['"])([A-Za-z0-9_.-]+)\1/g;
const TEMPLATE_CALL = /(?<![\w.$])t\(\s*`([^`$]*)\$\{/g;
const QUOTED_KEY = /(['"`])([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+)\1/g;

/** Every source file of the interface code, tests and generated code aside. */
export function codeFiles(dir = DEFAULT_CODE_DIR) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'locales') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...codeFiles(path));
    else if (CODE_FILE.test(name) && !NOT_CODE.test(name)) out.push(path);
  }
  return out;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * The top-level property names of the object literal that opens at
 * `source[start]` (a `{`), or `null` when it cannot say: a spread, a computed
 * name, an object that never closes.
 */
export function objectKeys(source, start) {
  let depth = 0;
  let quote = '';
  let end = -1;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  const body = source.slice(start + 1, end);
  const parts = [];
  let current = '';
  depth = 0;
  quote = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      current += c;
      if (c === '\\') { current += body[i + 1] ?? ''; i += 1; } else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    if (c === '{' || c === '(' || c === '[') depth += 1;
    if (c === '}' || c === ')' || c === ']') depth -= 1;
    if (c === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += c;
  }
  parts.push(current);
  const keys = [];
  for (const raw of parts) {
    const part = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
    if (!part) continue;
    const named = /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*(?::|$)/.exec(part);
    if (!named) return null;
    keys.push(named[2] ?? named[3] ?? '');
  }
  return keys;
}

/**
 * The uses of the product's messages in `files`:
 *  - `calls`: each literal `t('key', …)`, with the names of its arguments when
 *    the second argument is an object literal (`vars`), `[]` when there is
 *    none, `null` when they cannot be read (a variable, a spread);
 *  - `prefixes`: the fixed start of each key built at run time;
 *  - `quoted`: every quoted dotted string, wherever it stands — a key picked
 *    from a table (`{ ok: 'x.ok' }`) is used even if no `t(` precedes it.
 */
export function scanUsage(files = codeFiles(), { root = DEFAULT_CODE_DIR } = {}) {
  const calls = [];
  const prefixes = new Set();
  const quoted = new Set();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(QUOTED_KEY)) quoted.add(match[2] ?? '');
    if (!IMPORTS_T.test(source)) continue;
    for (const match of source.matchAll(TEMPLATE_CALL)) prefixes.add(match[1] ?? '');
    for (const match of source.matchAll(LITERAL_CALL)) {
      const key = match[2] ?? '';
      const after = source.slice((match.index ?? 0) + match[0].length);
      // `t('kind.' + x)`: a key built at run time, like a template.
      if (/^\s*\+/.test(after)) { prefixes.add(key); continue; }
      const next = /^\s*(\)|,\s*(\{)?)/.exec(after);
      let vars = null;
      // `t('x').split('{cmd}')` cuts the message around an argument on purpose,
      // to compose JSX between the halves: its arguments are not passed.
      if (next?.[1] === ')' && !/^\s*\)\s*\.split\(/.test(after)) vars = [];
      else if (next?.[2]) vars = objectKeys(source, (match.index ?? 0) + match[0].length + next[0].length - 1);
      calls.push({ file: relative(root, file).split(sep).join('/'), line: lineOf(source, match.index ?? 0), key, vars });
    }
  }
  return { calls, prefixes, quoted };
}

/**
 * English messages no code seems to read: neither called literally, nor quoted
 * anywhere, nor under a prefix a key is built from. A guess, never a gate: a
 * key assembled in a way the scan does not follow shows up here too.
 */
export function probablyUnused(keys, usage) {
  const used = new Set(usage.calls.map((call) => call.key));
  const prefixes = [...usage.prefixes].filter(Boolean);
  return keys.filter((key) => !used.has(key) && !usage.quoted.has(key) && !prefixes.some((prefix) => key.startsWith(prefix)));
}
