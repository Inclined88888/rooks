/**
 * Every widget of the product carries a picto in the widget window: the keys
 * of `WIDGET_PICTOS` are the catalogue copy's keys, no more, no less.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WIDGET_PICTOS, widgetPicto } from './widget-pictos';

function catalogKeys(locale: string): string[] {
  const file = join(process.cwd(), 'src', 'locales', locale, 'core.json');
  const json = JSON.parse(readFileSync(file, 'utf8')) as { widgetCatalog?: Record<string, unknown> };
  return Object.keys(json.widgetCatalog ?? {}).sort();
}

test('one picto per catalogue widget', () => {
  assert.deepEqual(Object.keys(WIDGET_PICTOS).sort(), catalogKeys('en'));
});

test('a picto is a plain 24×24 SVG with nothing to fetch or run', () => {
  for (const key of Object.keys(WIDGET_PICTOS)) {
    const svg = widgetPicto(key) ?? '';
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"/, key);
    assert.doesNotMatch(svg, /<script|href|url\(|<text|on\w+=/i, key);
  }
  assert.equal(widgetPicto('absent'), undefined);
});
