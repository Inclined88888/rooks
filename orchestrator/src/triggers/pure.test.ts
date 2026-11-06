import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { evaluateFilter, filterSchema, type Filter } from './filter.js';
import { lookup, type TriggerInput } from './payload.js';
import { renderTemplate } from './template.js';
import { generateSecret, publicHeaders, signGeneric, verifySignature } from './signature.js';
import { rateLimiter } from './limiter.js';

const input: TriggerInput = {
  body: {
    action: 'opened',
    number: 42,
    issue: { title: 'Crash on start', labels: [{ name: 'bug' }, { name: 'ui' }], body: null },
    tags: ['a', 'b'],
  },
  headers: { 'x-github-event': 'issues' },
};

const parse = (value: unknown): Filter => filterSchema.parse(value);

test('lookup walks own properties, arrays and case-insensitive headers only', () => {
  assert.equal(lookup(input, 'issue.labels.1.name'), 'ui');
  assert.equal(lookup(input, 'headers.X-GitHub-Event'), 'issues');
  assert.equal(lookup(input, '__proto__'), undefined);
  assert.equal(lookup(input, 'issue.constructor'), undefined);
  assert.equal(lookup(input, 'tags.x'), undefined);
});

test('every filter operator, groups and dotted paths', () => {
  const pass = (f: unknown) => evaluateFilter(parse(f), input);
  assert.equal(pass({ op: 'exists', path: 'issue.title' }), true);
  assert.equal(pass({ op: 'exists', path: 'issue.body' }), false, 'null does not exist');
  assert.equal(pass({ op: 'missing', path: 'issue.assignee' }), true);
  assert.equal(pass({ op: 'equals', path: 'action', value: 'opened' }), true);
  assert.equal(pass({ op: 'equals', path: 'number', value: '42' }), true, 'header-style string equals number');
  assert.equal(pass({ op: 'not_equals', path: 'action', value: 'closed' }), true);
  assert.equal(pass({ op: 'contains', path: 'issue.title', value: 'Crash' }), true);
  assert.equal(pass({ op: 'contains', path: 'tags', value: 'b' }), true);
  assert.equal(pass({ op: 'in', path: 'headers.X-GitHub-Event', values: ['issues', 'push'] }), true);
  assert.equal(pass({ op: 'regex', path: 'issue.title', pattern: '^crash', flags: 'i' }), true);
  assert.equal(pass({
    all: [
      { op: 'equals', path: 'action', value: 'opened' },
      { any: [{ op: 'contains', path: 'issue.labels.0.name', value: 'bug' }, { op: 'exists', path: 'nope' }] },
      { not: { op: 'equals', path: 'action', value: 'closed' } },
    ],
  }), true);
  assert.equal(evaluateFilter(null, input), true);
});

test('filters refuse unknown operators, regex outside the safe subset and oversized trees', () => {
  assert.throws(() => parse({ op: 'script', path: 'a' }));
  assert.throws(() => parse({ op: 'regex', path: 'a', pattern: '(a)\\1' }));
  assert.throws(() => parse({ op: 'regex', path: 'a', pattern: '(?=a)' }));
  assert.throws(() => parse({ op: 'regex', path: 'a', pattern: '(' }));
  assert.throws(() => parse({ op: 'equals', path: 'a b', value: 1 }));
  let deep: unknown = { op: 'exists', path: 'a' };
  for (let i = 0; i < 9; i++) deep = { not: deep };
  assert.throws(() => parse(deep));
});

test('templates replace valid paths only, never re-expand, cap values', () => {
  assert.equal(renderTemplate('#{number}: {issue.title} [{headers.X-GitHub-Event}]', input), '#42: Crash on start [issues]');
  assert.equal(renderTemplate('JSON {"a": 1} and { x } stay', input), 'JSON {"a": 1} and { x } stay');
  assert.equal(renderTemplate('{missing.field}!', input), '!');
  const nasty: TriggerInput = { body: { a: '{b}', b: 'secret', big: 'x'.repeat(5000) }, headers: {} };
  assert.equal(renderTemplate('{a}', nasty), '{b}', 'a value is never expanded again');
  assert.equal(renderTemplate('{big}', nasty).length, 4001);
  assert.equal(renderTemplate('{issue.labels}', input), '[{"name":"bug"},{"name":"ui"}]');
  assert.equal(renderTemplate('{issue.title}', input, 5), 'Cras…');
});

const body = Buffer.from('{"hello":"world"}');
const now = 1_790_000_000_000;

test('github: valid, wrong secret, missing; the replay key ignores the declared delivery id', () => {
  const secret = 'gh-secret';
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const withId = verifySignature('github', secret, body, { 'x-hub-signature-256': sig, 'x-github-delivery': 'd-1' }, now);
  assert.equal(withId.ok && withId.deliveryKey, 'github:d-1');
  const otherId = verifySignature('github', secret, body, { 'x-hub-signature-256': sig, 'x-github-delivery': 'd-2' }, now);
  const noId = verifySignature('github', secret, body, { 'x-hub-signature-256': sig }, now);
  assert.ok(withId.ok && otherId.ok && noId.ok);
  assert.match(String(withId.replayKey), /^sig:/);
  assert.equal(otherId.replayKey, withId.replayKey);
  assert.equal(noId.replayKey, withId.replayKey);
  assert.equal(noId.deliveryKey, null);
  assert.deepEqual(verifySignature('github', 'other', body, { 'x-hub-signature-256': sig }, now), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifySignature('github', secret, body, {}, now), { ok: false, reason: 'missing_signature' });
  const tampered = Buffer.from('{"hello":"w0rld"}');
  assert.equal(verifySignature('github', secret, tampered, { 'x-hub-signature-256': sig }, now).ok, false);
});

test('gitlab: shared token compared in constant time', () => {
  assert.deepEqual(verifySignature('gitlab', 'tok', body, { 'x-gitlab-token': 'tok', 'x-gitlab-event-uuid': 'u' }, now), { ok: true, replayKey: null, deliveryKey: 'gitlab:u' });
  assert.equal(verifySignature('gitlab', 'tok', body, { 'x-gitlab-token': 'tok2' }, now).ok, false);
});

test('standard webhooks: whsec secret, multiple signatures, ±300 s window', () => {
  const secret = generateSecret('standard');
  assert.match(secret, /^whsec_/);
  const key = Buffer.from(secret.slice(6), 'base64');
  const ts = String(Math.floor(now / 1000));
  const sign = (t: string) => `v1,${createHmac('sha256', key).update(`msg_1.${t}.${body.toString()}`).digest('base64')}`;
  const headers = (t: string) => ({ 'webhook-id': 'msg_1', 'webhook-timestamp': t, 'webhook-signature': `v1,AAAA ${sign(t)}` });
  assert.deepEqual(verifySignature('standard', secret, body, headers(ts), now), { ok: true, replayKey: 'standard:msg_1', deliveryKey: null });
  const old = String(Math.floor(now / 1000) - 301);
  assert.deepEqual(verifySignature('standard', secret, body, headers(old), now), { ok: false, reason: 'stale_timestamp' });
  assert.deepEqual(verifySignature('standard', 'whsec_AAAA', body, headers(ts), now), { ok: false, reason: 'bad_signature' });
});

test('generic V2: timestamp signed with the body, replay window enforced', () => {
  const secret = generateSecret('generic');
  const ts = Math.floor(now / 1000);
  const ok = verifySignature('generic', secret, body, signGeneric(secret, body, ts), now);
  assert.ok(ok.ok);
  assert.match(String(ok.replayKey), /^sig:/);
  // The declared id is not signed: changing it must not change the replay key.
  const renamed = verifySignature('generic', secret, body, { ...signGeneric(secret, body, ts), 'x-timon-delivery': 'b' }, now);
  assert.ok(renamed.ok);
  assert.equal(renamed.replayKey, ok.replayKey);
  assert.equal(renamed.deliveryKey, 'generic:b');
  assert.deepEqual(verifySignature('generic', secret, body, signGeneric(secret, body, ts - 400), now), { ok: false, reason: 'stale_timestamp' });
  // Shifting the timestamp invalidates the signature: it is part of what is signed.
  const moved = { ...signGeneric(secret, body, ts), 'x-timon-timestamp': String(ts + 1) };
  assert.deepEqual(verifySignature('generic', secret, body, moved, now), { ok: false, reason: 'bad_signature' });
});

test('credential headers never reach filters, templates or the journal', () => {
  const kept = publicHeaders({ 'X-Gitlab-Token': 's', Authorization: 'Bearer x', 'X-Hub-Signature-256': 'h', 'Webhook-Signature': 'w', 'X-Timon-Signature': 't', 'X-GitHub-Event': 'push' });
  assert.deepEqual(kept, { 'x-github-event': 'push' });
});

test('rate limiter: per-key ceilings, reset every window', () => {
  let time = 0;
  const allow = rateLimiter(() => time);
  for (let i = 0; i < 3; i++) assert.equal(allow([{ key: 'route:a', max: 3 }, { key: 'ip:x', max: 60 }]), true);
  assert.equal(allow([{ key: 'route:a', max: 3 }, { key: 'ip:x', max: 60 }]), false);
  assert.equal(allow([{ key: 'route:b', max: 3 }, { key: 'ip:x', max: 60 }]), true);
  time += 60_000;
  assert.equal(allow([{ key: 'route:a', max: 3 }]), true);
});
