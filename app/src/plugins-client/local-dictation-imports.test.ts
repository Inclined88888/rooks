/**
 * Ratchet of the `local-dictation` occupant (TODO #484 §3.5): its code
 * imports nothing of the app but the dictation contract's types and
 * `@timon/ui` — what a third-party engine gets. The desktop bridge
 * (`window.timonDesktop.speech`) is the one thing it has that a third party
 * has not, and it reads it from `window`, not from an import.
 *
 * A failure here means the occupant leaned on a product internal: expose what
 * it needs through the contract or `@timon/ui` instead (and record it in
 * `contract-surface.json`), never widen this list for convenience.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

const ROOT = join(process.cwd(), 'src', 'plugins-client');
const FOLDER = join(ROOT, 'local-dictation');
const ENTRY = join(ROOT, 'local-dictation.tsx');

/** External packages it may bundle, as a third party would. */
const PACKAGES = new Set(['react', 'react-dom', 'lucide-react', 'sonner']);
/** The public surfaces, by specifier; `typeOnly`: erased at build, nothing of the app runs. */
const SURFACES: Record<string, { typeOnly: boolean }> = {
  '@timon/ui': { typeOnly: false },
  // The app's mirror of the SDK's dictation types (`@timon-ai/sdk`).
  '@/lib/dictation/contract': { typeOnly: true },
};
/** The bundled half's own shape (`BundledClientPlugin`), from the entry file only. */
const ENTRY_TYPES = './types';

type Import = { specifier: string; typeOnly: boolean };

function importsOf(source: string): Import[] {
  const found: Import[] = [];
  for (const match of source.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\bfrom\s+['"]([^'"]+)['"]/gm)) {
    const clause = match[3]!;
    // `import { type A, type B }`: type-only too when every name is.
    const names = /\{([^}]*)\}/.exec(clause)?.[1]?.split(',').map((name) => name.trim()).filter(Boolean) ?? [];
    const allTypes = clause.trim().startsWith('{') && names.length > 0 && names.every((name) => name.startsWith('type '));
    found.push({ specifier: match[4]!, typeOnly: Boolean(match[2]) || allTypes });
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) found.push({ specifier: match[1]!, typeOnly: false });
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push({ specifier: match[1]!, typeOnly: false });
  return found;
}

/** Why `item` is refused in `file`, or null. */
function refusal(file: string, item: Import): string | null {
  const surface = SURFACES[item.specifier];
  if (surface) return surface.typeOnly && !item.typeOnly ? `${item.specifier} may only be imported with \`import type\`` : null;
  if (item.specifier.startsWith('.')) {
    if (file === ENTRY && item.specifier === ENTRY_TYPES) return item.typeOnly ? null : `${ENTRY_TYPES} may only be imported with \`import type\``;
    const target = resolve(join(file, '..'), item.specifier);
    const inside = target === ENTRY.replace(/\.tsx$/, '') || target === FOLDER || target.startsWith(FOLDER + sep);
    return inside ? null : `${item.specifier} leaves the occupant`;
  }
  if (item.specifier.startsWith('@/')) return `${item.specifier} is a product internal`;
  const name = item.specifier.startsWith('@') ? item.specifier.split('/').slice(0, 2).join('/') : item.specifier.split('/')[0]!;
  return PACKAGES.has(name) ? null : `${item.specifier} is not an allowed package`;
}

function occupantFiles(): string[] {
  const files = readdirSync(FOLDER)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => join(FOLDER, name));
  return [ENTRY, ...files];
}

test('the ratchet refuses what it exists to refuse', () => {
  const file = join(FOLDER, 'engine.ts');
  const refused = [
    "import { t } from '@/lib/i18n';",
    "import { DICTATION_ENGINE_SLOT } from '@/lib/dictation/contract';",
    "import { register } from '../../lib/plugin-host/slots';",
    "import { Button } from '@/components/ui/button';",
    "const m = await import('@/lib/desktop');",
    "import x from 'left-pad';",
    "export { localEngine } from '../settings';",
  ];
  for (const source of refused) {
    const items = importsOf(source);
    assert.ok(items.length > 0, source);
    assert.ok(items.some((item) => refusal(file, item) !== null), source);
  }
  const allowed = [
    "import type { DictationEngine } from '@/lib/dictation/contract';",
    "import { type DictationEngine, type DictationEvent } from '@/lib/dictation/contract';",
    "import { Button, t } from '@timon/ui';",
    "import { useState } from 'react';",
    "import type { SpeechBridge } from './desktop-speech';",
  ];
  for (const source of allowed) {
    for (const item of importsOf(source)) assert.equal(refusal(file, item), null, source);
  }
});

test('local-dictation imports nothing of app/src/lib but the contract\'s types and @timon/ui', () => {
  const problems: string[] = [];
  for (const file of occupantFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const item of importsOf(source)) {
      const why = refusal(file, item);
      if (why) problems.push(`${relative(process.cwd(), file)}: ${why}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(occupantFiles().length >= 7, 'the ratchet reads the occupant\'s files');
});
