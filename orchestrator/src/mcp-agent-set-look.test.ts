/**
 * `agent_set_look` on the MCP shim: it relays to `PUT /api/agent-look` with
 * only what the agent sent (the daemon picks the caller's own agent when
 * `agent` is left out), refuses an empty call before any request, relays the
 * daemon's refusal unchanged, and offers exactly the daemon's lists.
 * Stub daemon on 127.0.0.1:0 — the rights themselves are proved against the
 * real route in `plugins-bundled/agents/agent-look-route.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { session, withDaemon } from '../tests/helpers/mcp-cli-parity.js';
import {
  AGENT_LOOK_ACCESSORIES, AGENT_LOOK_COLORS, AGENT_LOOK_EYES, AGENT_LOOK_SHAPES, MASCOT_PART_ID_RE,
} from './agent-look.js';

const LOOK = { shape: 'round', color: '#d4a373', eyes: 'happy', acc: 'teacher' };
const tool = (args: Record<string, unknown>) => ({ method: 'tools/call', params: { name: 'agent_set_look', arguments: args } });

/** A look field of the tool schema: a product value, or a pack's part whose form only the schema checks. */
type LookField = { anyOf: [{ enum: string[] }, { pattern: string }] };

test('its own look: the call carries no agent, the daemon resolves the caller', async () => {
  await withDaemon(async (base, seen) => {
    await session(base, [tool({ look: LOOK, use_mascot: true })], true);
    const puts = seen.filter((s) => s.method === 'PUT');
    assert.deepEqual(puts.map((s) => `${s.method} ${s.url}`), ['PUT /api/agent-look']);
    assert.deepEqual(puts[0]!.body, { look: LOOK, use_mascot: true });
  });
});

test('an orchestrated agent is named in the body', async () => {
  await withDaemon(async (base, seen) => {
    await session(base, [tool({ agent: 'team.helper', look: LOOK })], true);
    const put = seen.find((s) => s.method === 'PUT');
    assert.deepEqual(put?.body, { agent: 'team.helper', look: LOOK });
  });
});

test('nothing to change is refused before any request', async () => {
  await withDaemon(async (base, seen) => {
    const [reply] = await session(base, [tool({ use_mascot: false })], true);
    assert.equal(reply!.result!.isError, true);
    assert.match(reply!.result!.content![0]!.text, /nothing to change/);
    assert.equal(seen.filter((s) => s.method === 'PUT').length, 0);
  });
});

test('the daemon refusal of another agent reaches the caller', async () => {
  const reason = 'agent "team.lead" does not orchestrate "other.agent"';
  await withDaemon(async (base) => {
    const [reply] = await session(base, [tool({ agent: 'other.agent', look: LOOK })], true);
    assert.equal(reply!.result!.isError, true);
    assert.ok(reply!.result!.content![0]!.text.includes(reason), reply!.result!.content![0]!.text);
  }, { status: 403, body: { error: 'forbidden', code: 'out_of_scope', reason } });
});

test('the schema offers exactly the values the daemon accepts', async () => {
  await withDaemon(async (base) => {
    const [list] = await session(base, [{ method: 'tools/list' }]);
    const found = list!.result!.tools!.find((t) => t.name === 'agent_set_look');
    assert.ok(found);
    const look = found.inputSchema.properties.look as { properties: Record<string, LookField> };
    assert.deepEqual(look.properties.shape!.anyOf[0]!.enum, [...AGENT_LOOK_SHAPES]);
      assert.equal(look.properties.shape!.anyOf[1]!.pattern, MASCOT_PART_ID_RE.source);
    assert.deepEqual(look.properties.color!.anyOf[0]!.enum, [...AGENT_LOOK_COLORS]);
      assert.equal(look.properties.color!.anyOf[1]!.pattern, MASCOT_PART_ID_RE.source);
    assert.deepEqual(look.properties.eyes!.anyOf[0]!.enum, [...AGENT_LOOK_EYES]);
      assert.equal(look.properties.eyes!.anyOf[1]!.pattern, MASCOT_PART_ID_RE.source);
    assert.deepEqual(look.properties.acc!.anyOf[0]!.enum, [...AGENT_LOOK_ACCESSORIES]);
      assert.equal(look.properties.acc!.anyOf[1]!.pattern, MASCOT_PART_ID_RE.source);
  });
});
