/**
 * Fin du tier core : ce que chaque module éteint coûte, et ce qu'il ne coûte
 * PAS.
 *
 * Deux promesses tenues ici, dans cet ordre de risque :
 *   1. `notifications` éteint ne fait échouer personne. Un agent clôt sa task
 *      par un rapport ; si ce rapport jetait, la task partirait BLOCKED pour
 *      une raison qui n'a rien à voir avec son travail.
 *   2. `web-push` éteint ne touche pas au centre in-app. Le push est un relais
 *      du centre, jamais l'inverse — les couper ensemble serait le bug que
 *      l'extraction est censée rendre impossible.
 */
// Isole TIMON_HOME AVANT tout module qui touche à l'état TIMON (cf. test-home.ts).
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createNotification, notificationsEnabled, registerPushSink,
        closePushFor, closePushForAnchor } = await import('../../notifications.js');
const { setActiveModules, resetActiveModules } = await import('../../kernel/module-state.js');
const { dbApi } = await import('../../db.js');
const { CATALOG } = await import('../../kernel/catalog.js');
const { planEntries } = await import('../../kernel/registry.js');
const { config } = await import('../../config/load.js');

test('notifications est std, web-push est opt, et web-push injecte notifications', async () => {
  const notifications = CATALOG.find((m) => m.id === '@timon/notifications');
  const webPush = CATALOG.find((m) => m.id === '@timon/web-push');
  assert.equal(notifications?.tier, 'std');
  assert.equal(webPush?.tier, 'opt');

  // Sans centre de notifications, le push n'a rien à relayer : la dépendance
  // est déclarée à Cordis, pas seulement documentée.
  const mod = await import('../web-push/index.js');
  assert.ok(mod.inject?.includes('notifications'));
});

test('le catalogue laisse éteindre notifications', () => {
  const cfg = { ...config(), modules: { '@timon/notifications': false } };
  const decisions = planEntries(CATALOG, { config: cfg, capabilities: [] });
  const d = decisions.find((x) => x.id === '@timon/notifications');
  assert.equal(d?.disabled, true);
  assert.match(d?.reason ?? '', /timon\.config\.json/);
});

test('centre éteint : createNotification ne jette pas, rend null, n’écrit rien', () => {
  // Le noyau a parlé et n'a pas nommé `notifications` : le centre est éteint.
  setActiveModules(['@timon/db', '@timon/http']);
  try {
    assert.equal(notificationsEnabled(), false);
    const before = dbApi.countActiveNotifications();
    const n = createNotification({ type: 'report', title: 'rapport de fin de task' });
    assert.equal(n, null);
    assert.equal(dbApi.countActiveNotifications(), before);
    // Fermer une notif système sans centre ni sink ne jette pas non plus.
    closePushFor({ id: 'inexistante', anchor: null });
    closePushForAnchor('inexistante');
  } finally {
    resetActiveModules();
  }
});

test('centre allumé sans web-push : la notification vit, le push est un vide', async () => {
  // Aucun noyau n'a parlé = tout est allumé (cf. `kernel/module-state.ts`).
  assert.equal(notificationsEnabled(), true);
  {
    const n = createNotification({ type: 'alert', urgent: true, title: 'sans push' });
    assert.ok(n, 'le centre in-app ne dépend pas du push');
    assert.equal(dbApi.getNotification(n.id)?.title, 'sans push');

    // `onPush` est bien appelé — avec le bilan d'un fan-out qui n'a pas eu
    // lieu. `permissions.ts` en déduit "personne n'a été joint", donc la
    // fenêtre courte : c'est la conclusion correcte, pas un repli.
    const seen: { delivered: number; configured: boolean }[] = [];
    createNotification({
      type: 'action_required',
      title: 'permission sans push',
      onPush: (r) => void seen.push({ delivered: r.delivered, configured: r.configured }),
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, [{ delivered: 0, configured: false }]);
  }
});

test('un sink enregistré reçoit le fan-out, et le débrancher l’arrête', async () => {
  const targets: string[] = [];
  const unregister = registerPushSink({
    notify: async (n) => {
      targets.push(n.title);
      return { configured: true, targeted: 1, delivered: 1, failed: 0, gone: 0, skipped: 0 };
    },
    closeFor: async () => {},
    closeForAnchor: async () => {},
  });
  try {
    createNotification({ type: 'action_required', title: 'avec sink' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(targets, ['avec sink']);

    unregister();
    createNotification({ type: 'action_required', title: 'sink débranché' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(targets, ['avec sink'], 'un module déchargé ne pousse plus');
  } finally {
    unregister();
  }
});
