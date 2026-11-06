import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { notificationHref } from './notification-href';

/**
 * Same cases as the daemon's `web-push/href.test.ts`: the rail and the phone
 * must open the same page for one card.
 */
const none = { mission_id: null, task_id: null };

test('a plugin consent card opens the Secrets page with the grant to confirm', () => {
  assert.equal(
    notificationHref({ ...none, anchor: 'plugin-secret:acme-connector:GITHUB_TOKEN' }),
    '/secrets?grant=GITHUB_TOKEN&plugin=acme-connector',
  );
  assert.equal(
    notificationHref({ ...none, anchor: 'plugin-secret:@acme/todo:sync:API_KEY' }),
    '/secrets?grant=API_KEY&plugin=%40acme%2Ftodo%3Async',
  );
});

test('a refused provider launch opens the providers settings on that plugin', () => {
  assert.equal(
    notificationHref({ ...none, anchor: 'provider-launch:acme-provider' }),
    '/?settings=models%2Fbackends&provider=acme-provider',
  );
  assert.equal(
    notificationHref({ ...none, anchor: 'provider-launch:@acme/x' }),
    '/?settings=models%2Fbackends&provider=%40acme%2Fx',
  );
  assert.equal(notificationHref({ ...none, anchor: 'provider-launch:' }), null);
});

test("a new outbound host opens the mission's chat on its Network view", () => {
  assert.equal(
    notificationHref({ mission_id: 'm-1', task_id: null, anchor: 'egress:m-1' }),
    '/chat?mission=m-1&egress=1',
  );
  assert.equal(notificationHref({ ...none, anchor: 'egress:a b' }), '/chat?mission=a%20b&egress=1');
  assert.equal(notificationHref({ mission_id: 'm-1', task_id: null, anchor: 'egress:' }), '/chat?mission=m-1&highlight=egress%3A');
});

test('anything that is not a well-formed consent anchor keeps its old meaning', () => {
  assert.equal(notificationHref({ ...none, anchor: 'plugin-secret:acme:lower_case' }), null);
  assert.equal(notificationHref({ ...none, anchor: 'plugin-secret::API_KEY' }), null);
  assert.equal(notificationHref({ ...none, anchor: 'plugin-spawn:acme' }), null);
  assert.equal(notificationHref({ ...none, anchor: '/settings' }), '/settings');
  assert.equal(
    notificationHref({ mission_id: 'm1', task_id: null, anchor: 'plugin-secret:acme:API_KEY' }),
    '/chat?mission=m1&highlight=plugin-secret%3Aacme%3AAPI_KEY',
  );
});
