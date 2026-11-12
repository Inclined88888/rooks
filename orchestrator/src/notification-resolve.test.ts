/**
 * SUG-0048: an action_required card goes away once the thing it asked for is
 * done — a dream queue emptied, a plugin approved, a permission whose process
 * died. Each family closes ITS card only (anchors never cross).
 */
import './test-home.js';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { createNotification, registerPushSink, resolveAnchor, resolveAnchorPrefix, resolveGoneAnchor } = await import('./notifications.js');
const { dismissOrphanedPermissionNotifications } = await import('./permissions.js');
const { NovaConfigSchema } = await import('./config/schema.js');
const { setConfig, resetConfig } = await import('./config/load.js');
const { assertSpawnAllowed, resetPluginPolicyState, PluginPolicyError, spawnCardsSettled } = await import('./plugins/policy.js');

const active = (id: string) => dbApi.getNotification(id)?.dismissed_at == null;

test('resolveAnchor closes the cards of that anchor and no other', () => {
  const dreams = createNotification({ type: 'action_required', title: 'Dreaming: 3 tracks', anchor: '/dreams' })!;
  const other = createNotification({ type: 'action_required', title: 'Memory', anchor: '/memory?run=1' })!;
  const report = createNotification({ type: 'report', title: 'report', anchor: '/dreams' })!;
  assert.equal(resolveAnchor('/dreams'), 1);
  assert.equal(active(dreams.id), false);
  assert.equal(active(other.id), true, 'another anchor stays');
  assert.equal(active(report.id), true, 'only action_required cards are closed');
  assert.equal(resolveAnchor('/dreams'), 0, 'idempotent');
});

test('a permission card orphaned by a restart is closed at boot, other cards stay', () => {
  const mission = randomUUID();
  dbApi.createMission(mission, 'rooks.coder', 'ask');
  const permId = randomUUID();
  dbApi.insertEvent(mission, 'permission_request', { id: permId, tool_name: 'Bash', tool_use_id: 'tu1' });
  const orphan = createNotification({ type: 'action_required', title: 'Permission required', missionId: mission, anchor: permId })!;
  const documentId = randomUUID();
  const document = createNotification({ type: 'action_required', title: 'A document waits', missionId: mission, anchor: documentId })!;
  const plain = createNotification({ type: 'action_required', title: 'From an agent', missionId: mission })!;

  assert.equal(dismissOrphanedPermissionNotifications(), 1);
  assert.equal(active(orphan.id), false);
  assert.equal(active(document.id), true, 'a document outlives the restart');
  assert.equal(active(plain.id), true);
});

test('a plugin spawning after its approval closes the approval card', async () => {
  resetPluginPolicyState();
  const policy = (approved: string[]) => setConfig(NovaConfigSchema.parse({ pluginPolicy: { spawn: { approved } } }));
  try {
    policy([]);
    assert.throws(() => assertSpawnAllowed('acme'), PluginPolicyError);
    // The card is raised and closed fire-and-forget: wait for the writes, never for a clock.
    await spawnCardsSettled();
    const card = dbApi.listActiveNotifications('action_required').find((n) => n.anchor === 'plugin-spawn:acme');
    assert.ok(card, 'the refusal raised a card');

    policy(['acme']);
    assertSpawnAllowed('acme');
    await spawnCardsSettled();
    assert.equal(active(card.id), false, 'the approved spawn closed it');
  } finally {
    resetConfig();
    resetPluginPolicyState();
  }
});

test('a spawn approved right after its refusal closes the card, in the order they happened', async () => {
  resetPluginPolicyState();
  const policy = (approved: string[]) => setConfig(NovaConfigSchema.parse({ pluginPolicy: { spawn: { approved } } }));
  try {
    policy([]);
    assert.throws(() => assertSpawnAllowed('swift'), PluginPolicyError);
    // No wait in between: the close is queued while the raise is still on its way.
    policy(['swift']);
    assertSpawnAllowed('swift');
    await spawnCardsSettled();
    const cards = dbApi.listNotifications({ archived: true, limit: 200 }).filter((n) => n.anchor === 'plugin-spawn:swift');
    assert.equal(cards.length, 1, 'the refusal raised its card');
    assert.notEqual(cards[0]!.dismissed_at, null, 'and the approved spawn closed it, though queued before it was written');
  } finally {
    resetConfig();
    resetPluginPolicyState();
  }
});

test('the dreams card closes only when no track is left to review', async () => {
  const { closeDreamsCardIfDone, DREAMS_ANCHOR } = await import('./dreaming.js');
  const id = dbApi.insertDreamProposal({ kind: 'improve', project: null, title: 't', body: 'b', rationale: 'r', effort: 'S', conviction: 3, sources: [], runId: 'r1' });
  const card = createNotification({ type: 'action_required', title: 'Dreaming: 1 track', anchor: DREAMS_ANCHOR })!;
  closeDreamsCardIfDone();
  assert.equal(active(card.id), true, 'a track still waits');
  dbApi.decideDream(id, 'rejected');
  closeDreamsCardIfDone();
  assert.equal(active(card.id), false);
});

test('an agent card closes on the human reply in its mission, never on an agent message', async () => {
  const { bus } = await import('./bus.js');
  const { startNotificationResolver } = await import('./notifications.js');
  const stop = startNotificationResolver();
  try {
    const mission = randomUUID();
    dbApi.createMission(mission, 'rooks.coder', 'ask');
    const card = createNotification({ type: 'action_required', title: 'Renew the token', missionId: mission, dismissOn: ['reply'] })!;
    const plain = createNotification({ type: 'action_required', title: 'No lifecycle', missionId: mission })!;
    const user = (payload: unknown) => bus.publish({ kind: 'event', missionId: mission, type: 'user', timestamp: Date.now(), payload });

    user({ type: 'user', message: { role: 'user', content: 'digest' }, origin: { kind: 'agent', from: 'rooks.reviewer' } });
    assert.equal(active(card.id), true, 'a relayed agent message is not an answer');
    user({ type: 'user', message: { role: 'user', content: 'done' }, origin: { presentation: { sections: [] } } });
    assert.equal(active(card.id), false, 'the human typed: the card closes');
    assert.equal(active(plain.id), true, 'a card without dismiss_on stays');
  } finally {
    stop();
  }
});

test('an agent card set on task_done closes when its task reaches DONE', async () => {
  const { bus } = await import('./bus.js');
  const { startNotificationResolver } = await import('./notifications.js');
  const stop = startNotificationResolver();
  try {
    const taskId = randomUUID();
    const card = createNotification({ type: 'action_required', title: 'Check the deploy', taskId, dismissOn: ['task_done'] })!;
    const other = createNotification({ type: 'action_required', title: 'Other task', taskId: randomUUID(), dismissOn: ['task_done'] })!;
    bus.publish({ kind: 'task_done', taskId });
    assert.equal(active(card.id), false);
    assert.equal(active(other.id), true);
  } finally {
    stop();
  }
});

test('the expiry sweep dismisses lapsed cards only', async () => {
  const { sweepExpiredNotifications } = await import('./notifications.js');
  const now = Date.now();
  const lapsed = createNotification({ type: 'action_required', title: 'Lapsed', expiresAt: now - 1 })!;
  const later = createNotification({ type: 'action_required', title: 'Later', expiresAt: now + 60_000 })!;
  assert.ok(sweepExpiredNotifications(now) >= 1);
  assert.equal(active(lapsed.id), false);
  assert.equal(active(later.id), true);
  sweepExpiredNotifications(now + 120_000);
  assert.equal(active(later.id), false);
});

test('a new permission clears stale permission cards, not an agent card of the same mission', async () => {
  const { dismissStaleNotifications } = await import('./permissions.js');
  const mission = randomUUID();
  dbApi.createMission(mission, 'rooks.coder', 'ask');
  const permId = randomUUID();
  dbApi.insertEvent(mission, 'permission_request', { id: permId, tool_name: 'Bash', tool_use_id: 'tu2' });
  const stale = createNotification({ type: 'action_required', title: 'Permission required', missionId: mission, anchor: permId })!;
  const agent = createNotification({ type: 'action_required', title: 'From the agent', missionId: mission, dismissOn: ['reply'] })!;
  const documentCard = createNotification({ type: 'action_required', title: 'A document', missionId: mission, anchor: randomUUID() })!;
  dismissStaleNotifications(mission);
  assert.equal(active(stale.id), false);
  assert.equal(active(agent.id), true);
  assert.equal(active(documentCard.id), true);
});

test('the lifecycle of an agent card: defaults, TTL fallback and refusals', async () => {
  const now = 1_000_000;
  const { notifyLifecycle, NOTIFY_DEFAULT_TTL_MIN, NOTIFY_BACKSTOP_TTL_MIN } = await import('./plugins-bundled/notifications/routes.js');
  const backstop = now + NOTIFY_BACKSTOP_TTL_MIN * 60_000;
  const link = { taskId: null, missionId: 'm1' };
  assert.deepEqual(
    notifyLifecycle({}, 'action_required', link, now),
    { dismissOn: ['reply'], expiresAt: backstop },
    'a reply may never come (an autonomous mission): the backstop still ends it',
  );
  assert.deepEqual(
    notifyLifecycle({}, 'action_required', { taskId: 't1', missionId: 'm1' }, now),
    { dismissOn: ['reply', 'task_done'], expiresAt: backstop },
  );
  assert.deepEqual(
    notifyLifecycle({}, 'action_required', { taskId: null, missionId: null }, now),
    { dismissOn: null, expiresAt: now + NOTIFY_DEFAULT_TTL_MIN * 60_000 },
    'nothing to detect: the TTL takes over',
  );
  assert.deepEqual(
    notifyLifecycle({ dismiss_on: [], ttl_minutes: 30 }, 'action_required', link, now),
    { dismissOn: null, expiresAt: now + 30 * 60_000 },
  );
  assert.deepEqual(notifyLifecycle({}, 'report', link, now), { dismissOn: null, expiresAt: null });
  assert.ok('error' in notifyLifecycle({ dismiss_on: ['soon'] }, 'action_required', link, now));
  assert.ok('error' in notifyLifecycle({ ttl_minutes: 0 }, 'action_required', link, now));
  assert.ok('error' in notifyLifecycle({ ttl_minutes: '5' }, 'action_required', link, now));
  assert.ok('error' in notifyLifecycle({ dismiss_on: ['task_done'] }, 'action_required', link, now), 'task_done needs a task');
  assert.ok('error' in notifyLifecycle({ dismiss_on: ['reply'] }, 'action_required', { taskId: null, missionId: null }, now));
  assert.ok('error' in notifyLifecycle({ ttl_minutes: 5 }, 'alert', link, now), 'alerts have no lifecycle');
});

test('a follow-up sent with a mission token is the calling agent\'s, not the human\'s', async () => {
  const { agentCallerOrigin } = await import('./plugins-bundled/missions/routes.js');
  type Auth = NonNullable<import('express').Request['auth']>;
  const req = (auth: Auth) => ({ auth }) as unknown as import('express').Request;
  const caller = randomUUID();
  dbApi.createMission(caller, 'rooks.reviewer', 'relay');
  assert.deepEqual(
    agentCallerOrigin(req({ kind: 'api-token', user: null, isSuperadmin: true, missionId: caller })),
    { kind: 'agent', from: 'rooks.reviewer', mission_id: caller },
  );
  assert.equal(agentCallerOrigin(req({ kind: 'session', user: null, isSuperadmin: false })), null, 'the human');
  assert.equal(agentCallerOrigin(req({ kind: 'daemon-token', user: null, isSuperadmin: true })), null, 'the CLI in a terminal');
  assert.equal(agentCallerOrigin(req({ kind: 'api-token', user: null, isSuperadmin: true, missionId: randomUUID() })), null);
});

/**
 * TODO #663: the CLI dismisses a removed plugin's cards from its own process, with
 * no push sink. The daemon that follows finds no row left, and must still close
 * the notification on the phones: its button would re-arm the removed id.
 */
test('an anchor gone for good closes on the devices even when the row is already dismissed', () => {
  const pushed: string[] = [];
  const unregister = registerPushSink({
    notify: async () => ({ configured: true, targeted: 0, delivered: 0, failed: 0, gone: 0, skipped: 0 }),
    closeFor: async () => {},
    closeForAnchor: async (anchor) => { pushed.push(anchor); },
  });
  const changes: unknown[] = [];
  const onEvent = (ev: { kind: string }) => { if (ev.kind === 'notifications_changed') changes.push(ev); };
  bus.on('event', onEvent);
  try {
    const anchor = `plugin-spawn:gone-${randomUUID()}`;
    const other = `${anchor}-2`;
    const card = createNotification({ type: 'action_required', title: 'wants to spawn', anchor })!;
    const neighbour = createNotification({ type: 'action_required', title: 'wants to spawn', anchor: other })!;
    assert.equal(dbApi.dismissNotificationsByAnchor(anchor, 'action_required'), 1, 'what the CLI did');

    changes.length = 0;
    assert.equal(resolveGoneAnchor(anchor), 0);
    assert.deepEqual(pushed, [anchor], 'the devices are told, and only for this anchor');
    assert.equal(changes.length, 1, 'open pages refresh their list');
    assert.equal(active(card.id), false);
    assert.equal(active(neighbour.id), true, 'an id that only starts the same is another plugin');

    pushed.length = 0;
    assert.equal(resolveGoneAnchor(other), 1, 'a card still open is dismissed');
    assert.deepEqual(pushed, [other]);
    assert.equal(active(neighbour.id), false);
  } finally {
    bus.off('event', onEvent);
    unregister();
  }
});

test('a prefix gone for good closes on the devices every anchor it raised, already dismissed included', () => {
  const pushed: string[] = [];
  const unregister = registerPushSink({
    notify: async () => ({ configured: true, targeted: 0, delivered: 0, failed: 0, gone: 0, skipped: 0 }),
    closeFor: async () => {},
    closeForAnchor: async (anchor) => { pushed.push(anchor); },
  });
  try {
    const id = `gone-${randomUUID()}`;
    const anchors = [`plugin-secret:${id}:A`, `plugin-secret:${id}:B`];
    const stranger = `plugin-secret:${id}-2:A`;
    for (const anchor of [...anchors, stranger]) createNotification({ type: 'action_required', title: 'grant it', anchor });
    pushed.length = 0;
    for (const anchor of anchors) dbApi.dismissNotificationsByAnchor(anchor, 'action_required');

    assert.equal(resolveAnchorPrefix(`plugin-secret:${id}:`), 0);
    assert.deepEqual(pushed.sort(), anchors);
  } finally {
    unregister();
  }
});

