/**
 * `ctx.messages` (API 10): the inbox of the agents a plugin created. Refusals
 * first — permission, anonymous, an account that opted out of communication,
 * agents that are not the plugin's — then the round trips.
 */
import { account, admin, anonymous, as, caller, code, pluginWith } from '../../tests/helpers/facade-kit.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { PluginPermissionError, PluginCallerError } = await import('./context.js');
const { upsertAgent, patchAgentConfig } = await import('../agent.js');
const { dbApi } = await import('../db.js');
const { systemMissionId } = await import('../notify.js');

const ALL = ['agents:manage', 'messages:send', 'messages:read'];
const ada = account('ada', ['agents:manage']);
const bob = account('bob', ['agents:manage']);
const mute = caller('mute', ['agents:manage', '-messages:send', '-messages:read']);
const input = (name: string) => ({ name, systemPrompt: `You are ${name}.`, role: 'research', backend: 'claude' });

upsertAgent({ name: 'human.helper', system_prompt: 'p', config: { role: 'coder' } });

/** What an agent does with `agent_send_message`: a row in the recipient's inbox. */
function fromAgent(fromAgentName: string, toAgent: string, over: Partial<Parameters<typeof dbApi.enqueueMessage>[0]> = {}) {
  return dbApi.enqueueMessage({
    id: randomUUID(), fromMission: systemMissionId(), fromAgent: fromAgentName, toAgent, kind: 'msg', payload: 'hello', ...over,
  });
}

test('every call needs its permission in the manifest', async () => {
  const { plugin, dispose } = await pluginWith(['agents:manage']);
  await assert.rejects(as(ada, () => plugin.messages.send({ to: 'human.helper', payload: 'x' })), PluginPermissionError);
  await assert.rejects(as(ada, () => plugin.messages.recv('human.helper')), PluginPermissionError);
  await assert.rejects(as(ada, () => plugin.messages.pick('id')), PluginPermissionError);
  await assert.rejects(as(ada, () => plugin.messages.reply('id', 'x')), PluginPermissionError);
  const sendOnly = await pluginWith(['messages:send'], 'send-only');
  await assert.rejects(as(ada, () => sendOnly.plugin.messages.recv('human.helper')), PluginPermissionError);
  const readOnly = await pluginWith(['messages:read'], 'read-only');
  await assert.rejects(as(ada, () => readOnly.plugin.messages.send({ to: 'human.helper', payload: 'x' })), PluginPermissionError);
  await sendOnly.dispose();
  await readOnly.dispose();
  await dispose();
});

test('an anonymous request is refused', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  await assert.rejects(as(anonymous, () => plugin.messages.send({ to: 'human.helper', payload: 'x' })), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.messages.recv('human.helper')), PluginCallerError);
  await dispose();
});

test('an account that opted out of inter-agent communication is refused', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  await as(ada, () => plugin.agents.create(input('muted-agent')));
  await assert.rejects(as(mute, () => plugin.messages.send({ to: 'human.helper', payload: 'x' })), PluginCallerError);
  await assert.rejects(as(mute, () => plugin.messages.recv('muted-agent')), PluginCallerError);
  assert.equal(dbApi.listInbox('human.helper', {}).length, 0);
  await dispose();
});

test('a job writes to and reads from its own agents only; a request may address any agent', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  await plugin.agents.create(input('bridge-a'));
  await assert.rejects(plugin.messages.send({ to: 'human.helper', payload: 'x' }), code('not_found'));
  assert.equal(dbApi.listInbox('human.helper', {}).length, 0, 'nothing reached a human agent');
  const sent = await plugin.messages.send({ to: 'bridge-a', payload: { text: 'from the outside' } });
  const [got] = await plugin.messages.recv('bridge-a');
  assert.equal(got!.id, sent.id);
  assert.equal(got!.from, 'plugin:acme-api10');
  assert.equal(got!.payload, '{"text":"from the outside"}');
  assert.equal(dbApi.getMessage(sent.id)?.owner_user_id, 'plugin:acme-api10');

  // A request: any agent as a recipient (the account's own right to talk to it).
  const toHuman = await as(ada, () => plugin.messages.send({ to: 'human.helper', payload: 'hi' }));
  assert.equal(dbApi.getMessage(toHuman.id)?.owner_user_id, 'ada');
  await dispose();
});

test('recv, pick and reply reach only the inbox of an agent THIS plugin created', async () => {
  const mine = await pluginWith(ALL, 'mine');
  const other = await pluginWith(ALL, 'other');
  await as(ada, () => mine.plugin.agents.create(input('mine-agent')));
  const theirs = await as(ada, () => other.plugin.agents.create(input('other-agent')));
  assert.ok(theirs);
  const secret = fromAgent('human.helper', 'other-agent', { payload: 'secret between others', ownerUserId: 'ada' });
  const humanInbox = fromAgent('x', 'human.helper', { payload: 'for a human', ownerUserId: 'ada' });

  for (const [who, name] of [[ada, 'request'], [undefined, 'job']] as const) {
    const run = <T>(fn: () => Promise<T>) => (who ? as(who, fn) : fn());
    const denied = name === 'job' ? 'not_found' : 'forbidden';
    await assert.rejects(run(() => mine.plugin.messages.recv('other-agent')), code(denied), `${name}: recv on another plugin's agent`);
    await assert.rejects(run(() => mine.plugin.messages.recv('human.helper')), code(denied), `${name}: recv on a human agent`);
    await assert.rejects(run(() => mine.plugin.messages.pick(secret.id)), code(denied), `${name}: pick`);
    await assert.rejects(run(() => mine.plugin.messages.pick(humanInbox.id)), code(denied), `${name}: pick on a human`);
    await assert.rejects(run(() => mine.plugin.messages.reply(secret.id, 'nosy')), code(denied), `${name}: reply`);
  }
  assert.equal(dbApi.getMessage(secret.id)?.status, 'pending', 'nothing was picked');
  assert.equal(dbApi.listInbox('other-agent', {}).length, 1, 'no reply was written');
  await mine.dispose();
  await other.dispose();
});

test('a request reads only the messages its account owns', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  await as(ada, () => plugin.agents.create(input('shared-bridge')));
  fromAgent('human.helper', 'shared-bridge', { payload: 'for ada', ownerUserId: 'ada' });
  fromAgent('human.helper', 'shared-bridge', { payload: 'for bob', ownerUserId: 'bob' });
  const adas = await as(ada, () => plugin.messages.recv('shared-bridge', { limit: 10 }));
  assert.deepEqual(adas.map((m) => m.payload), ['for ada']);
  // The agent is the plugin's, so Bob may use it, but he reads his own text only.
  assert.deepEqual((await as(bob, () => plugin.messages.recv('shared-bridge', { limit: 10 }))).map((m) => m.payload), ['for bob']);
  assert.equal((await as(admin, () => plugin.messages.recv('shared-bridge', { limit: 10 }))).length, 2);
  await dispose();
});

test('a message is written as one of the plugin\'s own agents, never as another', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  await as(ada, () => plugin.agents.create(input('speaker')));
  await assert.rejects(as(ada, () => plugin.messages.send({ to: 'speaker', payload: 'x', as: 'human.helper' })), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.messages.send({ to: 'speaker', payload: 'x', as: 'human.helper' })), code('forbidden'), 'a superadmin cannot forge a human agent either');
  await assert.rejects(plugin.messages.send({ to: 'speaker', payload: 'x', as: 'human.helper' }), code('not_found'));
  await assert.rejects(as(ada, () => plugin.messages.send({ to: 'human.helper', payload: 'x', kind: 'request' })), code('invalid'), 'a request needs an agent that can be answered');
  const ok = await as(ada, () => plugin.messages.send({ to: 'human.helper', payload: 'x', as: 'speaker' }));
  assert.equal(dbApi.getMessage(ok.id)?.from_agent, 'speaker');
  await dispose();
});

test('the team rule binds the agent written as, not the daemon\'s own mission', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  await as(ada, () => plugin.agents.create(input('team-a-bridge')));
  upsertAgent({ name: 'team.a', system_prompt: 'p', config: { role: 'coder', team: 'alpha' } });
  upsertAgent({ name: 'team.a2', system_prompt: 'p', config: { role: 'coder', team: 'alpha' } });
  upsertAgent({ name: 'team.b', system_prompt: 'p', config: { role: 'coder', team: 'beta' } });
  patchAgentConfig('team-a-bridge', { team: 'alpha' });
  await as(ada, () => plugin.messages.send({ to: 'team.a2', payload: 'same team', as: 'team-a-bridge' }));
  await assert.rejects(as(ada, () => plugin.messages.send({ to: 'team.b', payload: 'across teams', as: 'team-a-bridge' })), code('forbidden'));
  assert.equal(dbApi.listInbox('team.b', {}).length, 0);
  // An agent with no team keeps its reach, as in the route.
  await as(ada, () => plugin.agents.create(input('free-bridge')));
  await as(ada, () => plugin.messages.send({ to: 'team.b', payload: 'free', as: 'free-bridge' }));
  await dispose();
});

test('the input is validated', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  await as(ada, () => plugin.agents.create(input('validated')));
  const bad: unknown[] = [
    { to: '', payload: 'x' }, { to: 'validated' }, { to: 'validated', payload: '' }, { to: '../etc', payload: 'x' },
    { to: 'validated', payload: 'x', kind: 'notification' }, { to: 'validated', payload: 'x', extra: 1 },
    { to: 'validated', payload: 'x'.repeat(200_001) },
  ];
  for (const one of bad) await assert.rejects(as(ada, () => plugin.messages.send(one as never)), code('invalid'), JSON.stringify(one).slice(0, 60));
  await assert.rejects(as(ada, () => plugin.messages.send({ to: 'ghost', payload: 'x' })), code('not_found'));
  await assert.rejects(as(ada, () => plugin.messages.recv('validated', { limit: 0 })), code('invalid'));
  await assert.rejects(as(ada, () => plugin.messages.recv('validated', { status: 'bogus' as never })), code('invalid'));
  await dispose();
});

test('pick consumes a message once; recv filters by status and sender', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  await as(ada, () => plugin.agents.create(input('inbox')));
  const one = fromAgent('human.helper', 'inbox', { payload: 'one', ownerUserId: 'ada' });
  fromAgent('someone.else', 'inbox', { payload: 'two', ownerUserId: 'ada' });
  assert.deepEqual((await as(ada, () => plugin.messages.recv('inbox', { from: 'human.helper' }))).map((m) => m.payload), ['one']);
  const picked = await as(ada, () => plugin.messages.pick(one.id));
  assert.equal(picked.status, 'picked');
  assert.ok(picked.pickedAt);
  await assert.rejects(as(ada, () => plugin.messages.pick(one.id)), code('not_found'));
  assert.deepEqual((await as(ada, () => plugin.messages.recv('inbox'))).map((m) => m.payload), ['two']);
  assert.deepEqual((await as(ada, () => plugin.messages.recv('inbox', { status: 'picked' }))).map((m) => m.payload), ['one']);
  await dispose();
});

test('a request sent as an agent is answered into that agent\'s inbox; reply answers as the agent', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  await plugin.agents.create(input('asker'));
  await plugin.agents.create(input('responder'));
  // The plugin's agent `asker` asks `responder` (also the plugin's, so a job may).
  const ask = await plugin.messages.send({ to: 'responder', payload: 'what time is it?', kind: 'request', as: 'asker' });
  const [received] = await plugin.messages.recv('responder');
  assert.equal(received!.id, ask.id);
  assert.equal(received!.kind, 'request');
  const answer = await plugin.messages.reply(ask.id, 'noon');
  const [back] = await plugin.messages.recv('asker');
  assert.equal(back!.id, answer.id);
  assert.equal(back!.kind, 'response');
  assert.equal(back!.from, 'responder');
  assert.equal(back!.inReplyTo, ask.id);
  assert.equal(back!.payload, 'noon');
  assert.equal(dbApi.getMessage(answer.id)?.owner_user_id, 'plugin:acme-api10', 'the answer is owned like the question');
  await dispose();
});

test('a message sent as the plugin itself cannot be answered', async () => {
  const { plugin, dispose } = await pluginWith(ALL);
  await plugin.agents.create(input('mute-target'));
  const sent = await plugin.messages.send({ to: 'mute-target', payload: 'announcement' });
  await assert.rejects(plugin.messages.reply(sent.id, 'ok?'), code('invalid'));
  await assert.rejects(plugin.messages.reply('no-such-message', 'x'), code('not_found'));
  await dispose();
});
