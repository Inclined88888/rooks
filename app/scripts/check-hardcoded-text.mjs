#!/usr/bin/env node
/**
 * Guards against text written straight into the code instead of a message
 * file (docs/I18N.md, "Contributor tooling"):
 *
 *   node scripts/check-hardcoded-text.mjs            # compare to the baseline
 *   node scripts/check-hardcoded-text.mjs --update   # rewrite the baseline
 *
 * What it counts, read from the TypeScript syntax tree (not a regex: a
 * generic `useState<string>(…)` is not text between two tags):
 *  - `jsxText`: text between JSX tags holding a word (two letters or more),
 *    outside `<code>`, `<kbd>`, `<pre>` and `<samp>`;
 *  - `jsxAttr`: a literal string with a word in an attribute a reader sees or
 *    hears (`title`, `placeholder`, `aria-label`, `alt`, `label`…);
 *  - `french`: any string literal holding a French letter (`é`, `à`, `ç`, `œ`…), in
 *    any file: French copy that never reached a message file.
 * In `app/src` (all three) and `desktop/src` (`french` only: the shell has no
 * JSX, its English copy is not told apart from code by a pattern).
 *
 * A ratchet: the debt found on 04/11/2026 is frozen file by file in
 * `hardcoded-text-baseline.json`. A count may go down, never up; a file
 * absent from the baseline holds none. When a file improves, `--update`
 * lowers its line (a lower count than the baseline never fails, so two tasks
 * cleaning in parallel do not break each other).
 *
 * A legitimate literal (a brand, a sample value in a placeholder, a format
 * nobody translates) carries `i18n-exempt: <reason>` on its line or the line
 * above — `{/* i18n-exempt: … *\/}` in JSX. The word "Rooks" alone is never
 * translated and never counted.
 *
 * Node only; `typescript` comes from the app's own dependencies.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(join(appDir, 'package.json'))('typescript');

export const KINDS = ['jsxText', 'jsxAttr', 'french'];
export const DEFAULT_ROOTS = [
  { dir: join(appDir, 'src'), kinds: KINDS },
  { dir: join(appDir, '..', 'desktop', 'src'), kinds: ['french'] },
];
export const BASELINE_FILE = join(appDir, 'scripts', 'hardcoded-text-baseline.json');
/** Paths in the baseline are relative to the repository root, `/`-separated. */
const repoDir = join(appDir, '..');

const CODE_FILE = /\.(ts|tsx|mts|cts)$/;
const NOT_CODE = /\.test\.[cm]?tsx?$|\.d\.ts$/;
const VISIBLE_ATTRS = new Set([
  'title', 'placeholder', 'alt', 'label', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext',
]);
const CODE_TAGS = new Set(['code', 'kbd', 'pre', 'samp']);
const WORD = /\p{L}{2,}/u;
// french-ok: the French letters this check looks for
const FRENCH = /[àâçéèêëîïôûùüÿœæ]/i;
const NEVER_TRANSLATED = new Set(['Rooks']);
const EXEMPT = /i18n-exempt:\s*[\p{L}\d]/u;

function sourceFiles(dir) {
  const out = [];
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (CODE_FILE.test(name) && !NOT_CODE.test(name)) out.push(path);
  }
  return out;
}

function insideCodeTag(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent) && CODE_TAGS.has(parent.openingElement.tagName.getText())) return true;
  }
  return false;
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
  return null;
}

/**
 * The hard-coded texts of one source, each with its kind and line. `kinds`
 * picks what to look for; `name` decides JSX parsing (`.tsx`).
 */
export function findHardcodedText(text, name, kinds = KINDS) {
  const want = new Set(kinds);
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split('\n');
  const found = [];
  const add = (kind, node, value) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if (EXEMPT.test(lines[line] ?? '') || EXEMPT.test(lines[line - 1] ?? '')) return;
    found.push({ kind, line: line + 1, text: value.replace(/\s+/g, ' ').trim().slice(0, 80) });
  };
  const visit = (node) => {
    if (want.has('jsxText') && node.kind === ts.SyntaxKind.JsxText) {
      const value = node.getText(source).trim();
      if (WORD.test(value) && !NEVER_TRANSLATED.has(value) && !insideCodeTag(node)) add('jsxText', node, value);
    } else if (want.has('jsxAttr') && ts.isJsxAttribute(node) && node.initializer && VISIBLE_ATTRS.has(node.name.getText(source))) {
      const init = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      const value = init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) ? init.text : null;
      if (value !== null && WORD.test(value) && !NEVER_TRANSLATED.has(value.trim())) add('jsxAttr', node, `${node.name.getText(source)}="${value}"`);
    }
    if (want.has('french')) {
      const value = literalText(node);
      if (value !== null && FRENCH.test(value)) {
        add('french', node, value);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Per file (repository-relative, `/`-separated): its findings. */
export function scanHardcodedText(roots = DEFAULT_ROOTS) {
  const byFile = {};
  for (const root of roots) {
    for (const file of sourceFiles(root.dir)) {
      const found = findHardcodedText(readFileSync(file, 'utf8'), file, root.kinds);
      if (found.length > 0) byFile[relative(repoDir, file).split(sep).join('/')] = found;
    }
  }
  return byFile;
}

/** `{ file: { kind: count } }`, sorted, for the baseline. */
export function countByFile(byFile) {
  const counts = {};
  for (const file of Object.keys(byFile).sort()) {
    const perKind = {};
    for (const finding of byFile[file]) perKind[finding.kind] = (perKind[finding.kind] ?? 0) + 1;
    counts[file] = Object.fromEntries(KINDS.filter((kind) => perKind[kind]).map((kind) => [kind, perKind[kind]]));
  }
  return counts;
}

export function readBaseline(file = BASELINE_FILE) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Compares findings to the baseline. `over`: a file holding more of a kind
 * than its baseline allows, with the findings to look at. `under`: a file
 * that now holds less, whose baseline line `--update` can lower.
 */
export function compareToBaseline(byFile, baseline) {
  const counts = countByFile(byFile);
  const over = [];
  const under = [];
  for (const [file, perKind] of Object.entries(counts)) {
    for (const [kind, count] of Object.entries(perKind)) {
      const allowed = baseline[file]?.[kind] ?? 0;
      if (count > allowed) over.push({ file, kind, count, allowed, findings: byFile[file].filter((f) => f.kind === kind) });
    }
  }
  for (const [file, perKind] of Object.entries(baseline)) {
    for (const [kind, allowed] of Object.entries(perKind)) {
      const count = counts[file]?.[kind] ?? 0;
      if (count < allowed) under.push({ file, kind, count, allowed });
    }
  }
  return { over, under };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const byFile = scanHardcodedText();
  if (process.argv.includes('--update')) {
    writeFileSync(BASELINE_FILE, `${JSON.stringify(countByFile(byFile), null, 2)}\n`);
    console.log(`[check-hardcoded-text] baseline rewritten: ${Object.keys(byFile).length} file(s)`);
    process.exit(0);
  }
  const { over, under } = compareToBaseline(byFile, readBaseline());
  for (const entry of over) {
    console.error(`error    ${entry.file}: ${entry.count} ${entry.kind} (baseline ${entry.allowed})`);
    for (const finding of entry.findings) console.error(`           line ${finding.line}: ${finding.text}`);
  }
  for (const entry of under) console.log(`lower    ${entry.file}: ${entry.kind} ${entry.allowed} → ${entry.count} (run with --update)`);
  const total = Object.values(byFile).reduce((sum, list) => sum + list.length, 0);
  console.log(`[check-hardcoded-text] ${over.length} file(s) over the baseline, ${total} hard-coded text(s) left`);
  process.exit(over.length > 0 ? 1 : 0);
}
