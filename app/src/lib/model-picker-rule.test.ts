import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * One model picker everywhere (ModelPicker 6/6, docs/MODEL-PICKER.md): a
 * screen that lets someone choose a model mounts `ModelPickerPanel` or
 * `ModelPickerPopover` from `@/components/model-picker`. It never renders its
 * own list of models — that is how the product ended up with seven selectors
 * that each forgot the favourites, the accounts or the search.
 *
 * This guard fails when a `.tsx` outside `components/model-picker/` and
 * `lib/` renders a catalogue's model list: `modelsFor(`, `.models.map(` or a
 * local `models.map(` (the old node settings filled a `<select>` that way).
 * A file that needs it for another reason than choosing a model goes in
 * `EXCEPTIONS` with that reason; an exception that no longer matches fails
 * too, so the list cannot rot.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const PATTERNS = [/\bmodelsFor\(/, /\.models\.(?:map|flatMap)\(/, /\bmodels\.(?:map|flatMap)\(/];

/** Allowed outside the picker, path relative to `app/src` with `/`, and why. */
const EXCEPTIONS: Record<string, string> = {
  'plugins-client/backends/model-editor.tsx':
    'Settings › AI models › Providers: edits the list a provider declares (slug, label, window, default, hidden) — it is the catalogue, not a choice from it.',
};

function isAllowedDir(rel: string): boolean {
  return rel.startsWith('components/model-picker/') || rel.startsWith('lib/');
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') tsxFiles(path, out);
    } else if (entry.name.endsWith('.tsx') && !/\.test\.tsx$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function offences(source: string): string[] {
  const found: string[] = [];
  source.split('\n').forEach((line, i) => {
    if (PATTERNS.some((p) => p.test(line))) found.push(`${i + 1}: ${line.trim()}`);
  });
  return found;
}

test('no screen renders its own list of models: they go through the ModelPicker', () => {
  const hits = new Map<string, string[]>();
  for (const path of tsxFiles(SRC)) {
    const rel = relative(SRC, path).split(sep).join('/');
    if (isAllowedDir(rel)) continue;
    const found = offences(readFileSync(path, 'utf8'));
    if (found.length) hits.set(rel, found);
  }
  const unexpected = [...hits].filter(([rel]) => !(rel in EXCEPTIONS));
  assert.deepEqual(
    unexpected.map(([rel, lines]) => `${rel}\n  ${lines.join('\n  ')}`),
    [],
    'a model list rendered outside components/model-picker/: mount ModelPickerPanel or ModelPickerPopover '
      + '(filter, inherit, footer cover the special cases), or add the file to EXCEPTIONS with the reason',
  );
  const stale = Object.keys(EXCEPTIONS).filter((rel) => !hits.has(rel));
  assert.deepEqual(stale, [], 'an exception no longer needed: remove it from EXCEPTIONS');
});

test('the guard sees the shapes it is meant to catch, and not their neighbours', () => {
  assert.equal(offences('{modelsFor(catalog, backend).map((m) => <option key={m.slug} />)}').length, 1);
  assert.equal(offences('{backend.models.map((model) => (').length, 1);
  assert.equal(offences('{models.map((item) => <option key={item.slug} value={item.slug}>{item.label}</option>)}').length, 1);
  assert.equal(offences('const model = backend?.models.find((m) => m.slug === slug);').length, 0);
  assert.equal(offences('const count = backend.models.filter((m) => !m.hidden).length;').length, 0);
});
