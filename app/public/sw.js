// TIMON service worker.
//
// Two roles:
//   1. make the site installable — Chrome / Brave on Android only grant the
//      WebAPK (standalone display, entry in the app drawer) to a site whose
//      SW listens to `fetch`. The handler is empty on purpose: no offline
//      cache, everything goes to the network as usual.
//   2. carry Web Push: show permission requests and deep-link to the
//      Allow/Deny card on click.
//
// The payload is produced by orchestrator/src/push.ts and is either
//   { kind: 'notification', id, title, body, tag, url, urgent, permissionId, machineId }
//   { kind: 'close', tag }   <- the permission was resolved/expired
//
// A non-null `permissionId` -> the decision is a plain yes/no, so the
// Approve / Deny buttons are shown. Clicking one POSTs the resolution to
// `/api/ui/permissions/:id/resolve`, i.e. EXACTLY the route the UI's
// Allow/Deny card already uses: same origin, same cookies
// (`credentials: 'include'`), same authentication posture. No route dedicated
// to the service worker was opened — a "SW-only" path would be a weaker door
// than the UI, and the SW has nothing a tab does not have.
// If the call fails (network down, tailnet unreachable), we fall back to the
// original behaviour: open the app on the card.
//
// Multi-machine (TODO #329, P4b): `machineId` names the fleet machine that
// posted the card (relayed by the local daemon), `null` for a card of THIS
// daemon. A notification always answers for ITS machine, never for the one
// the interface shows at that moment:
//   - Approve / Deny send `X-Timon-Machine` (the machine, or `local`), the
//     only header the resolve route honours to target a machine other than
//     the active one; `permissionId` is the id OVER THERE.
//   - a click on the notification first switches the interface to that
//     machine, with the same POST as the picker (`/api/ui/machines/active`,
//     same origin), then opens the card. The switch does not go through a
//     `/?machine=<id>` URL: a GET that switches could be triggered by any
//     site with a plain navigation.
/**
 * The worker's own strings. It is a static file outside the bundle, so it has
 * no `t()`: it carries its two languages here, like a plugin's own translator,
 * and follows the browser's language (the cookie that stores the app's choice
 * is out of a worker's reach).
 */
const STRINGS = {
  en: {
    approve: 'Approve',
    deny: 'Deny',
    allowed: 'Permission granted ✓',
    denied: 'Permission denied ✓',
    gone: 'This request was already resolved or has expired.',
    failed: 'The answer failed (HTTP {status}). Open Timon to decide.',
  },
  fr: {
    approve: 'Approuver',
    deny: 'Refuser',
    allowed: 'Permission accordée ✓',
    denied: 'Permission refusée ✓',
    gone: 'Cette demande était déjà résolue ou expirée.',
    failed: 'Échec de la réponse (HTTP {status}). Ouvre Timon pour décider.',
  },
};

function text(key, vars) {
  const language = String((self.navigator && self.navigator.language) || 'en').toLowerCase().split('-')[0];
  const table = STRINGS[language] || STRINGS.en;
  const template = table[key] || STRINGS.en[key];
  return template.replace(/\{(\w+)\}/g, (match, name) => (vars && name in vars ? String(vars[name]) : match));
}

/** Header value and switch target: the card's machine, `local` by default. */
function machineOf(data) {
  const id = data && data.machineId;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'local';
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Intentionally empty — let the network handle every request.
});

/**
 * The instance's identity (product or dev copy), read FROM THE MANIFEST.
 *
 * A service worker is a static file: it sees neither the server's environment
 * nor the React context that carry the variant on the page side. But
 * `/manifest.webmanifest` is rendered on demand and already carries the
 * instance's name and icon — the only source that crosses this boundary.
 * Without it, a notification from the dev instance reaches the phone under
 * the product's name and icon, and nothing says which of the two spoke.
 *
 * Memoized for the worker's lifetime: an origin does not change instance.
 * A missing network falls back to the product.
 */
let identityPromise = null;
function instanceIdentity() {
  if (!identityPromise) {
    identityPromise = fetch('/manifest.webmanifest', { credentials: 'omit' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('manifest'))))
      .then((manifest) => ({
        name: manifest.short_name || 'TIMON',
        icon: (manifest.icons && manifest.icons[0] && manifest.icons[0].src) || '/icon-192.png',
      }))
      .catch(() => ({ name: 'TIMON', icon: '/icon-192.png' }));
  }
  return identityPromise;
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  // Close order: the card can no longer be acted on in TIMON, so remove the
  // notification from the phone's drawer instead of leaving a false positive.
  if (data.kind === 'close') {
    event.waitUntil(
      self.registration
        .getNotifications({ tag: data.tag, includeTriggered: true })
        .then((list) => list.forEach((n) => n.close()))
        .catch(() => {}),
    );
    return;
  }

  const options = {
    body: data.body || '',
    // Same tag -> the new notification REPLACES the previous one instead of
    // stacking. The tag is keyed on the anchor (= the permission id), so one
    // Allow/Deny card = one line in the drawer.
    tag: data.tag || 'timon',
    renotify: Boolean(data.urgent),
    requireInteraction: Boolean(data.urgent),
    // Relative: resolved against the SW's origin, so we reopen the origin the
    // device subscribed through (tailnet or localhost) with no config.
    data: {
      url: data.url || '/notifications',
      id: data.id || null,
      permissionId: data.permissionId || null,
      tag: data.tag || 'timon',
      machineId: data.machineId || null,
    },
  };
  // Answer from the lock screen, without unlocking or opening the app: that is
  // the whole point of push for an autonomous mission which, unanswered, gets
  // denied automatically.
  if (data.permissionId) {
    options.actions = [
      { action: 'allow', title: text('approve') },
      { action: 'deny', title: text('deny') },
    ];
  }
  // The name and icon come from the instance: on the maintainer's phone, a
  // notification from the dev copy must announce itself as such.
  event.waitUntil(
    instanceIdentity().then((instance) =>
      self.registration.showNotification(data.title || instance.name, {
        ...options,
        icon: instance.icon,
        badge: instance.icon,
      }),
    ),
  );
});

/**
 * Feedback toast after an inline action. Reuses the original notification's
 * TAG: the message replaces the line instead of stacking a second one, and
 * the close order the orchestrator sends on resolution sweeps it anyway.
 * Success -> cleared after a few seconds; failure -> left in place, it
 * carries information the user must be able to read again.
 */
function ackNotification(data, body, ephemeral) {
  const tag = (data && data.tag) || 'timon';
  return instanceIdentity()
    .then((instance) =>
      self.registration.showNotification(instance.name, {
        body,
        tag,
        renotify: false,
        silent: true,
        requireInteraction: false,
        icon: instance.icon,
        badge: instance.icon,
        data: { url: (data && data.url) || '/notifications', machineId: (data && data.machineId) || null },
      }),
    )
    .then(() => {
      if (!ephemeral) return undefined;
      return new Promise((r) => setTimeout(r, 6000)).then(() =>
        self.registration
          .getNotifications({ tag })
          .then((list) => list.forEach((n) => n.close()))
          .catch(() => {}),
      );
    })
    .catch(() => {});
}

/**
 * Inline resolution of a permission. Three outcomes, all explicit:
 *   200 -> the agent is unblocked, we confirm;
 *   404 -> the permission was already resolved or expired (the auto-deny
 *          fired, or the user clicked in the UI): we SAY so, we do not
 *          pretend to have acted;
 *   network down -> no certainty, so open the app on the card rather than
 *          let the user believe it is settled.
 */
function resolvePermissionInline(permissionId, behavior, data) {
  return fetch(`/api/ui/permissions/${encodeURIComponent(permissionId)}/resolve`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-timon-machine': machineOf(data) },
    body: JSON.stringify(
      // `origin` records the GESTURE on the server side (incident 2026-08-21:
      // we did not know where a decision came from, hence not whether the
      // card had been rendered). The deny reason stays distinct from the chat UI's.
      behavior === 'allow'
        ? { behavior: 'allow', origin: 'push_action' }
        : {
            behavior: 'deny',
            origin: 'push_action',
            message:
              'Denied from the system notification (Deny button). '
              + 'The user saw the request and declined it.',
          },
    ),
  })
    .then((res) => {
      if (res.ok) {
        return ackNotification(data, text(behavior === 'allow' ? 'allowed' : 'denied'), true);
      }
      if (res.status === 404) {
        return ackNotification(data, text('gone'), false);
      }
      return ackNotification(data, text('failed', { status: res.status }), false);
    })
    .catch(() => openOnMachine(machineOf(data), (data && data.url) || '/notifications'));
}

/**
 * Switches this origin's interface to `machine`; true when done.
 * Capped at 3 s: the window opening that follows must stay within the
 * interaction credit the click gives the worker.
 */
function switchMachine(machine) {
  return fetch('/api/ui/machines/active', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: machine }),
    signal: AbortSignal.timeout(3000),
  })
    .then((res) => res.ok)
    .catch(() => false);
}

/**
 * Opens `target` on the card's machine. A remote machine that can no longer
 * be reached (unreachable, removed from the fleet, device revoked): come back
 * to this computer, where the relayed copy of the card waits in the
 * notifications, rather than open a stuck screen.
 */
function openOnMachine(machine, target) {
  return switchMachine(machine).then((ok) => {
    if (ok || machine === 'local') return openTarget(target);
    return switchMachine('local').then(() => openTarget('/notifications'));
  });
}

function openTarget(target) {
  const absolute = new URL(target, self.location.origin).href;
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientList) => {
      // Reuse a TIMON tab already open rather than stack a new one on every
      // notification: navigate it to the deep link.
      for (const client of clientList) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if ('navigate' in client) {
          return client.navigate(absolute).then((c) => (c && c.focus ? c.focus() : undefined));
        }
        return client.focus();
      }
      return self.clients.openWindow(absolute);
    })
    .catch(() => self.clients.openWindow(absolute));
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();

  // Approve / Deny button: answer in place, the app does not open.
  if ((event.action === 'allow' || event.action === 'deny') && data.permissionId) {
    event.waitUntil(resolvePermissionInline(data.permissionId, event.action, data));
    return;
  }

  event.waitUntil(openOnMachine(machineOf(data), data.url || '/notifications'));
});
