/**
 * Product rule: Skills + Connectors are one Capabilities nav entry — never
 * separate Customize/Skills/Connectors menus. Asserted from the client plugin
 * source (no React mount required).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const agentsPlugin = readFileSync(join(root, 'app/src/plugins-client/agents.tsx'), 'utf8');
const capsPage = readFileSync(join(root, 'app/src/plugins-client/capabilities/capabilities-page.tsx'), 'utf8');

test('Desk registers one Capabilities nav item, not separate Skills/Connectors entries', () => {
  assert.match(agentsPlugin, /href: '\/capabilities'/);
  assert.match(agentsPlugin, /labelKey: 'nav\.capabilities'/);
  assert.doesNotMatch(agentsPlugin, /href: '\/skills'/);
  assert.doesNotMatch(agentsPlugin, /href: '\/mcp'/);
  assert.match(agentsPlugin, /CAPABILITY_ROUTES/);
});

test('Capabilities page owns Skills + Connectors tabs once', () => {
  assert.match(capsPage, /nav\.skills/);
  assert.match(capsPage, /nav\.connectors/);
  assert.match(capsPage, /never duplicated/i);
});
