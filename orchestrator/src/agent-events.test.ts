/**
 * `agent_created`, `agent_updated`, `agent_deleted`: published at the core's
 * write points, so a write from the page, the CLI, an MCP tool or a plugin is
 * seen the same way, with the writer named.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

const { bus } = await import('./bus.js');
await import('../tests/helpers/claude-provider.js');

const { upsertAgent, patchAgentConfig, deleteAgent, renameAgent, writeDoc, deleteDoc, createEphemeralAgent } = await import('./agent.js');
const { currentWriteOrigin, recordWriteOrigin, withWriteOrigin } = await import('./write-origin.js');

type Seen = { kind: string; agent: { name: string; created_by: string | null; role: string | null }; changed?: readonly string[]; previousName?: string | null; origin: { kind: string; id: string | null } };

function record(): { seen: Seen[]; stop: () => void } {
  const seen: Seen[] = [];
  const listener = (ev: { kind: string } & Record<string, unknown>) => {
    if (!ev.kind.startsWith('agent_') || ev.kind === 'agent_message') return;
    seen.push({ ...(ev as unknown as Seen), origin: currentWriteOrigin() });
  };
  bus.on('event', listener);
  return { seen, stop: () => bus.off('event', listener) };
}

test('a new agent publishes agent_created with its origin mark and the writer', () => {
  const { seen, stop } = record();
  withWriteOrigin({ kind: 'plugin', id: 'acme' }, () => {
    upsertAgent({ name: 'evt.one', system_prompt: 'p', config: { role: 'research' } }, { createdBy: 'plugin:acme' });
  });
  stop();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.kind, 'agent_created');
  assert.equal(seen[0]!.agent.name, 'evt.one');
  assert.equal(seen[0]!.agent.created_by, 'plugin:acme', 'the snapshot already carries the mark');
  assert.deepEqual(seen[0]!.origin, { kind: 'plugin', id: 'acme' });
});

test('the snapshot never carries the prompt, directory, tools or MCP servers', () => {
  const { seen, stop } = record();
  upsertAgent({ name: 'evt.lean', system_prompt: 'secret', config: { role: 'coder', mcp_servers: ['x'], allowed_tools: ['Bash'] } });
  stop();
  assert.deepEqual(Object.keys(seen[0]!.agent).sort(), ['backend', 'created_by', 'has_system_prompt', 'model', 'name', 'project', 'role']);
});

test('createdBy never rewrites the mark of an agent that exists', () => {
  upsertAgent({ name: 'evt.kept', system_prompt: 'p', config: { role: 'research' } });
  const { seen, stop } = record();
  upsertAgent({ name: 'evt.kept', system_prompt: 'p2', config: { role: 'research' } }, { createdBy: 'plugin:thief' });
  stop();
  assert.equal(seen[0]!.kind, 'agent_updated');
  assert.equal(seen[0]!.agent.created_by, null);
});

test('a patch names what it changed, and nothing is published when nothing changed', () => {
  upsertAgent({ name: 'evt.patch', system_prompt: 'p', config: { role: 'research', model: 'sonnet' } });
  const { seen, stop } = record();
  patchAgentConfig('evt.patch', { model: 'opus' });
  patchAgentConfig('evt.patch', { model: 'opus' });
  stop();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.changed, ['model']);
});

test('a rewrite names the prompt among what changed', () => {
  upsertAgent({ name: 'evt.prompt', system_prompt: 'one', config: { role: 'research' } });
  const { seen, stop } = record();
  upsertAgent({ name: 'evt.prompt', system_prompt: 'two', config: { role: 'research' } });
  stop();
  assert.deepEqual(seen[0]!.changed, ['system_prompt']);
});

test('a doc write and delete are updates named after the file', () => {
  upsertAgent({ name: 'evt.doc', system_prompt: 'p', config: { role: 'research' } });
  const { seen, stop } = record();
  writeDoc('evt.doc', 'SOUL.md', 'soul');
  deleteDoc('evt.doc', 'SOUL.md');
  stop();
  assert.deepEqual(seen.map((s) => s.changed), [['doc:SOUL.md'], ['doc:SOUL.md']]);
});

test('a rename is an update carrying the old name', () => {
  upsertAgent({ name: 'evt.old', system_prompt: 'p', config: { role: 'research' } }, { createdBy: 'plugin:acme' });
  const { seen, stop } = record();
  assert.equal(renameAgent('evt.old', 'evt.new').ok, true);
  stop();
  assert.equal(seen[0]!.kind, 'agent_updated');
  assert.equal(seen[0]!.agent.name, 'evt.new');
  assert.equal(seen[0]!.previousName, 'evt.old');
  assert.deepEqual(seen[0]!.changed, ['name']);
  assert.equal(seen[0]!.agent.created_by, 'plugin:acme', 'the mark follows the directory');
});

test('a delete publishes the agent as it stood before the removal', () => {
  upsertAgent({ name: 'evt.gone', system_prompt: 'p', config: { role: 'coder' } }, { createdBy: 'plugin:acme' });
  const { seen, stop } = record();
  assert.equal(deleteAgent('evt.gone'), true);
  assert.equal(deleteAgent('evt.gone'), false);
  stop();
  assert.equal(seen.length, 1, 'a delete of a missing agent says nothing');
  assert.equal(seen[0]!.kind, 'agent_deleted');
  assert.equal(seen[0]!.agent.role, 'coder');
  assert.equal(seen[0]!.agent.created_by, 'plugin:acme');
});

test('an ephemeral agent is never announced', () => {
  const { seen, stop } = record();
  const eph = createEphemeralAgent({ system_prompt: 'p', hint: 'evt' });
  stop();
  assert.ok(eph);
  assert.deepEqual(seen, []);
});

test('the middleware names the writer of a mutating request and ignores a read', () => {
  const req = (method: string) => ({ method, auth: { kind: 'session', user: { id: 'u1' } }, header: () => undefined }) as unknown as Request;
  const origins: Array<{ kind: string; id: string | null }> = [];
  recordWriteOrigin(req('POST'), {} as Response, () => origins.push(currentWriteOrigin()));
  recordWriteOrigin(req('GET'), {} as Response, () => origins.push(currentWriteOrigin()));
  assert.deepEqual(origins, [{ kind: 'user', id: 'u1' }, { kind: 'system', id: null }]);
});
