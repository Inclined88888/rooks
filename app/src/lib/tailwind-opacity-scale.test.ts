import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Tailwind 3.4 only generates an opacity modifier from its scale (0, 5, 10 …
 * 100, `tailwind.config.ts` does not extend it): `bg-primary/12` compiles to
 * nothing, and the selected option of the question form had no background at
 * all in light theme. A value off the scale is written `/[0.12]`.
 */
const SCALE = new Set(Array.from({ length: 21 }, (_, i) => String(i * 5)));
const MODIFIED = /(?<![\w-])(?:bg|text|border|ring|ring-offset|from|via|to|fill|stroke|outline|shadow|divide|placeholder|accent|caret|decoration)-[a-z]+(?:-[a-z0-9]+)*\/(\d+)\b(?!\/)/g;

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
  });
}

test('every opacity modifier is on the Tailwind scale', () => {
  const offenders = sources(SRC).flatMap((path) => {
    const text = readFileSync(path, 'utf8');
    return [...text.matchAll(MODIFIED)]
      .filter((match) => !SCALE.has(match[1]!))
      .map((match) => `${relative(SRC, path)}: ${match[0]}`);
  });
  assert.deepEqual(offenders, []);
});
