/**
 * `pendingPermMissions` counted permission_request minus resolved/expired, and
 * a mission that ended with a card still open kept its entry — and a wrong
 * "has a pending permission" answer — until the daemon restarted.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { missionHasPendingPermission } = await import('./agent.js');
const { bus } = await import('./bus.js');

test('a mission that ends with a permission card open stops counting as waiting', () => {
  const id = 'mission-pending-perm-0001';
  bus.publish({ kind: 'event', missionId: id, type: 'permission_request', timestamp: Date.now(), payload: {} });
  assert.equal(missionHasPendingPermission(id), true);
  bus.publish({ kind: 'mission_complete', missionId: id, status: 'terminated', exitCode: null });
  assert.equal(missionHasPendingPermission(id), false);
});
