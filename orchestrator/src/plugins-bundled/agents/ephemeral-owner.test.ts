/**
 * TODO #551 — `POST /api/agents/ephemeral` stamps an owner on the mission it
 * starts: an unowned mission's token carries no permission, so the helper
 * could not call the API it was spawned to use.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../../../tests/helpers/paid-license.js');
const { dbApi } = await import('../../db.js');
const { ephemeralOwner } = await import('./routes.js');

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'ada', passwordHash: 'x', isSuperadmin: false });
dbApi.createMission('mission-of-ada', 'acme.main', 'work', undefined, ada.id);
dbApi.createMission('mission-of-nobody', 'acme.cron', 'work', undefined, null);

const operator = { auth: { kind: 'daemon-token', isSuperadmin: true, user: null } } as never;

test('the mission it was spawned for gives the owner', () => {
  assert.equal(ephemeralOwner(operator, { parent_mission_id: 'mission-of-ada' }), ada.id);
});

test('a parent mission nobody owns keeps the helper unowned', () => {
  assert.equal(ephemeralOwner(operator, { parent_mission_id: 'mission-of-nobody' }), null);
});

test('without a known parent, the requesting account', () => {
  const asAda = { auth: { kind: 'session', isSuperadmin: false, user: { id: ada.id } } } as never;
  assert.equal(ephemeralOwner(asAda, { parent_mission_id: 'no-such-mission' }), ada.id);
  assert.equal(ephemeralOwner(asAda, undefined), ada.id);
  assert.equal(ephemeralOwner(operator, null), null);
});

test('a caller cannot borrow the owner of a mission it does not see', () => {
  const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'bob', passwordHash: 'x', isSuperadmin: false });
  dbApi.createMission('mission-of-bob', 'acme.main', 'work', undefined, bob.id);
  const asAda = { auth: { kind: 'session', isSuperadmin: false, user: { id: ada.id } } } as never;
  assert.equal(ephemeralOwner(asAda, { parent_mission_id: 'mission-of-bob' }), ada.id);
});
