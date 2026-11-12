/**
 * TIM-0118: the human bubbles of a mission belong to its owner, not to whoever
 * reads it. A superadmin opening an employee's mission saw their own name and
 * face on every message the employee had typed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HumanFace, humanSpeaker, parseMissionOwner } from './human-speaker';

// The test loader may compile JSX with the classic runtime.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const admin = { id: 'u-admin', name: 'Robin Admin', email: 'robin@example.com', avatar_url: '/api/uploads/admin.png' };
const employee = { id: 'u-emp', name: 'Alice Martin', avatar_url: null };

test("someone else's mission speaks with its owner's name and initials", () => {
  const speaker = humanSpeaker(employee, admin);
  assert.deepEqual(speaker, { name: 'Alice Martin', avatar_url: null, initials: 'AM' });
  const html = renderToStaticMarkup(React.createElement(HumanFace, { speaker }));
  assert.match(html, />AM</);
  assert.doesNotMatch(html, /admin\.png|Robin Admin/);
});

test("the owner's picture wins over the viewer's", () => {
  const html = renderToStaticMarkup(
    React.createElement(HumanFace, { speaker: humanSpeaker({ ...employee, avatar_url: '/api/uploads/alice.png' }, admin) }),
  );
  assert.match(html, /src="\/api\/uploads\/alice\.png"/);
});

test('own mission, or a mission without owner, stays on the viewer', () => {
  const own = humanSpeaker({ id: admin.id, name: admin.name, avatar_url: admin.avatar_url }, admin);
  assert.equal(own?.name, 'Robin Admin');
  assert.equal(humanSpeaker(null, admin)?.avatar_url, '/api/uploads/admin.png');
  assert.equal(humanSpeaker(undefined, null), null);
});

test('parseMissionOwner accepts the daemon shape and nothing else', () => {
  assert.deepEqual(parseMissionOwner({ id: 'u1', name: 'A', avatar_url: '' }), { id: 'u1', name: 'A', avatar_url: null });
  assert.equal(parseMissionOwner(null), null);
  assert.equal(parseMissionOwner({ id: '', name: 'A' }), null);
  assert.equal(parseMissionOwner({ id: 'u1' }), null);
  assert.equal(parseMissionOwner('u1'), null);
});

test('the chat bubble and the rail render the mission owner, measured against the account acting on the active machine', () => {
  const chat = readFileSync(new URL('../../app/chat/chat-client.tsx', import.meta.url), 'utf8');
  // `actingUser(me)`: on a remote machine, missions are owned by the account
  // the device acts as there, not by the local session's (TODO #646).
  assert.match(chat, /humanSpeaker\(owner, actingUser\(me\)\)/);
  assert.match(chat, /<HumanFace speaker=\{human\}/);
  assert.doesNotMatch(chat, /me\?\.user\?\.avatar_url/);
  const rail = readFileSync(new URL('./mission-rail.tsx', import.meta.url), 'utf8');
  assert.match(rail, /const viewer = actingUser\(me\);/);
  assert.match(rail, /m\.owner\.id !== viewer\.id/);
});
