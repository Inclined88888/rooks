import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalConnectorsToCut } from './mcp-least-privilege.js';

const SERVERS = [
  { id: 'ext-claude.ai-notes', name: 'claude.ai Notes', source: 'claude_ai' as const },
  { id: 'ext-claude.ai-gmail', name: 'claude.ai Gmail', source: 'claude_ai' as const },
  { id: 'ext-context7', name: 'context7', source: 'claude_cli' as const },
  { id: 'ext-rooks', name: 'rooks', source: 'claude_cli' as const },
  { id: 'local-acme', name: 'acme', source: 'rooks' as const },
];

test('with no connector named, a task agent inherits no account connector', () => {
  const cut = externalConnectorsToCut(SERVERS, { wanted: new Set(), kept: '', readOnly: false });
  assert.deepEqual(cut, ['ext-claude.ai-notes', 'ext-claude.ai-gmail', 'ext-context7']);
});

test('the named notes connector is kept, every other one is cut', () => {
  const cut = externalConnectorsToCut(SERVERS, { wanted: new Set(), kept: 'ext-claude.ai-notes', readOnly: false });
  assert.deepEqual(cut, ['ext-claude.ai-gmail', 'ext-context7']);
});

test('a mission that reads untrusted data keeps not even the named connector', () => {
  const cut = externalConnectorsToCut(SERVERS, { wanted: new Set(), kept: 'ext-claude.ai-notes', readOnly: true });
  assert.ok(cut.includes('ext-claude.ai-notes'));
});

test('what the agent asks for stays, and Rooks\'s own servers and local servers are never cut', () => {
  const cut = externalConnectorsToCut(SERVERS, { wanted: new Set(['ext-context7']), kept: '', readOnly: false });
  assert.deepEqual(cut, ['ext-claude.ai-notes', 'ext-claude.ai-gmail']);
});
