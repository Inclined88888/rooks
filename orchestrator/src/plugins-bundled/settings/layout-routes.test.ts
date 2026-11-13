/**
 * `/api/layout` — daemon-side persistence of the widget placement.
 *
 * What breaks silently here: a GET on a scope that was never written must
 * answer `layout: null` and not a 404, otherwise the front reads a failure
 * where there is simply nothing stored yet and drops back to the defaults for
 * the wrong reason.
 *
 * No bind on the production port: the witness server listens on 127.0.0.1:0.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

const { registerRoutes } = await import('./routes.js');

const app = express();
app.use(express.json());
registerRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;

test.after(() => { server.close(); });

test('GET on an unknown scope answers the empty layout, not a 404', async () => {
  const res = await fetch(`${base}/api/layout?scope=never-written`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { scope: 'never-written', layout: null, updatedAt: null });
});

test('PUT then GET gives the stored value back, verbatim', async () => {
  const layout = [{ id: 'agenda', rail: 'gauche', rang: 0, hauteur: 240 }];
  const put = await fetch(`${base}/api/layout`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layout }),
  });
  assert.equal(put.status, 200);
  const written = await put.json() as { ok: boolean; scope: string; updatedAt: number };
  assert.deepEqual({ ok: written.ok, scope: written.scope }, { ok: true, scope: 'cockpit' });
  assert.equal(typeof written.updatedAt, 'number');

  const got = await (await fetch(`${base}/api/layout`)).json() as
    { scope: string; layout: unknown; updatedAt: number | null };
  assert.equal(got.scope, 'cockpit');
  assert.deepEqual(got.layout, layout);
  assert.equal(typeof got.updatedAt, 'number');
});

test('a second PUT replaces the value instead of piling a second row', async () => {
  const first = [{ id: 'a' }];
  const second = [{ id: 'b' }];
  for (const layout of [first, second]) {
    await fetch(`${base}/api/layout?scope=replace`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout }),
    });
  }
  const got = await (await fetch(`${base}/api/layout?scope=replace`)).json() as { layout: unknown };
  assert.deepEqual(got.layout, second);
});

test('scopes are isolated from one another', async () => {
  await fetch(`${base}/api/layout?scope=other`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layout: ['other'] }),
  });
  const cockpit = await (await fetch(`${base}/api/layout`)).json() as { layout: unknown };
  assert.deepEqual(cockpit.layout, [{ id: 'agenda', rail: 'gauche', rang: 0, hauteur: 240 }]);
});

test('a PUT without layout, or with an oversized one, is refused', async () => {
  const empty = await fetch(`${base}/api/layout`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);

  const huge = await fetch(`${base}/api/layout`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layout: { pad: 'x'.repeat(70 * 1024) } }),
  });
  assert.equal(huge.status, 400);
});

/**
 * The exact boundary, pinned on both sides.
 *
 * The browser refuses a named layout before sending it, against its own copy
 * of this number (`MAX_PRESETS_BYTES` in `app/src/lib/layout-presets.ts`).
 * A cap moved here alone would either make the front refuse what the daemon
 * takes, or let it announce a success that comes back a 400 — so the value is
 * asserted, not just its effect.
 */
test('the cap is 64 KiB of the stored value, and it is the value that is measured', async () => {
  const { LAYOUT_MAX_BYTES } = await import('./routes.js');
  assert.equal(LAYOUT_MAX_BYTES, 64 * 1024);

  // Sized against `JSON.stringify(layout)` — what the route measures — and
  // not against the `{ layout }` envelope the request carries.
  const pad = (bytes: number) => {
    const overhead = Buffer.byteLength(JSON.stringify({ pad: '' }));
    return { pad: 'x'.repeat(bytes - overhead) };
  };
  assert.equal(Buffer.byteLength(JSON.stringify(pad(LAYOUT_MAX_BYTES))), LAYOUT_MAX_BYTES);

  const put = (layout: unknown) => fetch(`${base}/api/layout?scope=boundary`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layout }),
  });
  assert.equal((await put(pad(LAYOUT_MAX_BYTES))).status, 200, 'a row exactly at the cap is taken');
  assert.equal((await put(pad(LAYOUT_MAX_BYTES + 1))).status, 400, 'one byte over is refused');
});

test('a scope that is not a plain slug is refused', async () => {
  const res = await fetch(`${base}/api/layout?scope=${encodeURIComponent('../escape')}`);
  assert.equal(res.status, 400);
});

test('two sessions keep two distinct cockpit layouts; ?user= is ignored', async () => {
  const { createDaemonAuthMiddleware } = await import('../http/auth.js');
  const { dbApi } = await import('../../db.js');
  const { hashSessionToken, issueSessionToken, SESSION_COOKIE } = await import('../../users/session.js');

  const ada = createTestAccount(dbApi, {
    email: 'ada@example.com',
    name: 'Ada',
    passwordHash: 'x',
    isSuperadmin: false,
  });
  const bob = createTestAccount(dbApi, {
    email: 'bob@example.com',
    name: 'Bob',
    passwordHash: 'x',
    isSuperadmin: false,
  });

  function sessionFor(userId: string): string {
    const raw = issueSessionToken();
    dbApi.createSession({
      tokenHash: hashSessionToken(raw),
      userId,
      expiresAt: Date.now() + 60_000,
    });
    return raw;
  }

  const adaCookie = sessionFor(ada.id);
  const bobCookie = sessionFor(bob.id);

  const authed = express();
  authed.use(createDaemonAuthMiddleware({ token: 'witness-layout-token', required: true }));
  authed.use(express.json());
  registerRoutes(authed);
  const srv = authed.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const authedPort = (srv.address() as AddressInfo).port;
  assert.notEqual(authedPort, 3000, 'the witness must not take the production port');
  const authedBase = `http://127.0.0.1:${authedPort}`;

  try {
    const templateBefore = dbApi.uiLayoutGet('', 'cockpit');
    const adaLayout = [{ id: 'ada-agenda', rail: 'gauche' }];
    const bobLayout = [{ id: 'bob-git', rail: 'droite' }];

    const adaPut = await fetch(`${authedBase}/api/layout?scope=cockpit&user=${encodeURIComponent(bob.id)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(adaCookie)}`,
      },
      body: JSON.stringify({ layout: adaLayout }),
    });
    assert.equal(adaPut.status, 200);

    const bobPut = await fetch(`${authedBase}/api/layout?scope=cockpit`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(bobCookie)}`,
      },
      body: JSON.stringify({ layout: bobLayout }),
    });
    assert.equal(bobPut.status, 200);

    const adaGot = await (await fetch(`${authedBase}/api/layout?scope=cockpit`, {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(adaCookie)}` },
    })).json() as { layout: unknown };
    const bobGot = await (await fetch(`${authedBase}/api/layout?scope=cockpit`, {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(bobCookie)}` },
    })).json() as { layout: unknown };
    assert.deepEqual(adaGot.layout, adaLayout);
    assert.deepEqual(bobGot.layout, bobLayout);
    assert.notDeepEqual(adaGot.layout, bobGot.layout);

    assert.deepEqual(
      dbApi.uiLayoutGet('', 'cockpit'),
      templateBefore,
      'copy-on-write must not mutate the machine template',
    );
  } finally {
    srv.close();
  }
});

/**
 * `?prefix=` — the fan of scopes a workspace writes, read as one.
 *
 * What breaks silently here: a scope containing `_` must not be matched as a
 * LIKE wildcard. Without the escape, `a_b.` would also return `axb.`, and a
 * preset saved from one workspace would quietly carry another one's rows.
 */
test('a prefix read returns every scope under it, and nothing beside it', async () => {
  const rows: Record<string, unknown> = {
    'v2.abc.widgets': [{ id: 'agenda' }],
    'v2.abc.columns': { left: 240 },
    'v2.abd.widgets': [{ id: 'other' }],
  };
  for (const [scope, layout] of Object.entries(rows)) {
    await fetch(`${base}/api/layout?scope=${scope}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout }),
    });
  }
  const got = await (await fetch(`${base}/api/layout?prefix=v2.abc.`)).json() as
    { prefix: string; layouts: { scope: string; layout: unknown; updatedAt: number }[] };
  assert.equal(got.prefix, 'v2.abc.');
  assert.deepEqual(got.layouts.map((row) => row.scope), ['v2.abc.columns', 'v2.abc.widgets']);
  assert.deepEqual(got.layouts.find((row) => row.scope === 'v2.abc.widgets')!.layout, rows['v2.abc.widgets']);
});

test('an underscore in the prefix stays a literal, not a LIKE wildcard', async () => {
  for (const scope of ['pre_fix.kept', 'preXfix.other']) {
    await fetch(`${base}/api/layout?scope=${scope}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: { scope } }),
    });
  }
  const got = await (await fetch(`${base}/api/layout?prefix=pre_fix.`)).json() as
    { layouts: { scope: string }[] };
  assert.deepEqual(got.layouts.map((row) => row.scope), ['pre_fix.kept']);
});

test('an empty or malformed prefix is refused rather than sweeping the table', async () => {
  for (const prefix of ['', 'Upper.', '.leading']) {
    const res = await fetch(`${base}/api/layout?prefix=${encodeURIComponent(prefix)}`);
    assert.equal(res.status, 400, `prefix ${JSON.stringify(prefix)} must be refused`);
  }
});

test('a prefix matching nothing is an empty list, not a 404', async () => {
  const res = await fetch(`${base}/api/layout?prefix=nothing-here.`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { prefix: 'nothing-here.', layouts: [] });
});

test('deleting a scope forgets the row; deleting an absent one is still a success', async () => {
  await fetch(`${base}/api/layout?scope=to-forget`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layout: { kept: false } }),
  });
  const gone = await fetch(`${base}/api/layout?scope=to-forget`, { method: 'DELETE' });
  assert.equal(gone.status, 200);
  assert.deepEqual(await gone.json(), { ok: true, scope: 'to-forget', updatedAt: null });

  const after = await (await fetch(`${base}/api/layout?scope=to-forget`)).json();
  assert.deepEqual(after, { scope: 'to-forget', layout: null, updatedAt: null });

  const again = await fetch(`${base}/api/layout?scope=never-existed`, { method: 'DELETE' });
  assert.equal(again.status, 200);
});

/**
 * Two windows on the same view each hold a copy of the row. The one left on an
 * old copy must not rewrite the row over what the other added (TODO #375):
 * a write carrying the version it read is refused once the row has moved.
 */
const putAt = (scope: string, layout: unknown, expected?: string, at = base) =>
  fetch(`${at}/api/layout?scope=${scope}${expected === undefined ? '' : `&expected=${expected}`}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layout }),
  });
const readAt = async (scope: string, at = base) =>
  (await (await fetch(`${at}/api/layout?scope=${scope}`)).json()) as { layout: unknown; updatedAt: number | null };

test('a window left on an old copy cannot overwrite what another window wrote', async () => {
  await putAt('two-windows.islands', { tabs: ['chat'] });
  const desktop = await readAt('two-windows.islands');
  const browser = await readAt('two-windows.islands');
  assert.equal(desktop.updatedAt, browser.updatedAt);

  // The desktop adds an island, then the browser, still on its copy, moves one.
  const added = await putAt('two-windows.islands', { tabs: ['chat', 'files'] }, String(desktop.updatedAt));
  assert.equal(added.status, 200);
  const stale = await putAt('two-windows.islands', { tabs: ['chat'], moved: true }, String(browser.updatedAt));
  assert.equal(stale.status, 409);
  const conflict = await stale.json() as { error: string; updatedAt: number };
  assert.equal(conflict.error, 'conflict');

  const now = await readAt('two-windows.islands');
  assert.deepEqual(now.layout, { tabs: ['chat', 'files'] });
  assert.equal(conflict.updatedAt, now.updatedAt);
  // Re-read, the same gesture goes through.
  assert.equal((await putAt('two-windows.islands', { tabs: ['chat', 'files'], moved: true }, String(now.updatedAt))).status, 200);
});

test('a write chained on its own answer passes, even within the same millisecond', async () => {
  const first = await putAt('chained.widgets', [1], 'none');
  assert.equal(first.status, 200);
  let at = (await first.json() as { updatedAt: number }).updatedAt;
  for (let i = 2; i < 6; i++) {
    const next = await putAt('chained.widgets', [i], String(at));
    assert.equal(next.status, 200, `write ${i}`);
    const v = (await next.json() as { updatedAt: number }).updatedAt;
    assert.ok(v > at, 'every write moves the version');
    at = v;
  }
});

test('expected=none means "I read nothing": refused once a row exists', async () => {
  assert.equal((await putAt('first-read.columns', { a: 1 }, 'none')).status, 200);
  assert.equal((await putAt('first-read.columns', { b: 2 }, 'none')).status, 409);
  assert.deepEqual((await readAt('first-read.columns')).layout, { a: 1 });
});

test('without expected, a write stays unconditional', async () => {
  await putAt('blind.widgets', [1]);
  assert.equal((await putAt('blind.widgets', [2])).status, 200);
  assert.deepEqual((await readAt('blind.widgets')).layout, [2]);
});

test('a malformed expected is refused before anything is written', async () => {
  for (const bad of ['abc', '-1', '1.5', '']) {
    const res = await putAt('bad-expected.widgets', [1], bad);
    assert.equal(res.status, 400, `expected=${bad}`);
  }
  assert.equal((await readAt('bad-expected.widgets')).layout, null);
  const del = await fetch(`${base}/api/layout?scope=bad-expected.widgets&expected=x`, { method: 'DELETE' });
  assert.equal(del.status, 400);
});

test('an erasure carrying a stale version is refused too', async () => {
  await putAt('erase-guard.widgets', [1]);
  const read = await readAt('erase-guard.widgets');
  await putAt('erase-guard.widgets', [2]);
  const stale = await fetch(`${base}/api/layout?scope=erase-guard.widgets&expected=${read.updatedAt}`, { method: 'DELETE' });
  assert.equal(stale.status, 409);
  assert.deepEqual((await readAt('erase-guard.widgets')).layout, [2]);
  const fresh = await readAt('erase-guard.widgets');
  const ok = await fetch(`${base}/api/layout?scope=erase-guard.widgets&expected=${fresh.updatedAt}`, { method: 'DELETE' });
  assert.equal(ok.status, 200);
  assert.equal((await readAt('erase-guard.widgets')).layout, null);
});

test('a user who read the machine template writes their own row against its version', async () => {
  const { dbApi } = await import('../../db.js');
  const user = createTestAccount(dbApi, { email: 'template-reader@example.com', name: 'Reader', passwordHash: 'x', isSuperadmin: false });
  const asUser = express();
  asUser.use((req, _res, next) => {
    (req as unknown as { auth: unknown }).auth = { kind: 'session', user: { id: user.id } };
    next();
  });
  asUser.use(express.json());
  registerRoutes(asUser);
  const srv = asUser.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const at = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await putAt('template-fallback.widgets', ['template']);
    const template = await readAt('template-fallback.widgets', at);
    assert.deepEqual(template.layout, ['template']);
    assert.equal((await putAt('template-fallback.widgets', ['mine'], 'none', at)).status, 409, 'the template IS what was read');
    const own = await putAt('template-fallback.widgets', ['mine'], String(template.updatedAt), at);
    assert.equal(own.status, 200);
    assert.deepEqual((await readAt('template-fallback.widgets', at)).layout, ['mine']);
    assert.deepEqual((await readAt('template-fallback.widgets')).layout, ['template'], 'the template is untouched');
  } finally {
    srv.close();
  }
});

test('a DELETE on a malformed scope is refused', async () => {
  const res = await fetch(`${base}/api/layout?scope=Upper`, { method: 'DELETE' });
  assert.equal(res.status, 400);
});

/**
 * The maintainer's rule (14/10/2026): an agent changes the screen through a proposal the
 * owner applies, never by writing the rows itself. Its mission token still
 * reads them — `widgets_get` and the proposal's preview need it.
 */
test('a mission token reads the layout but cannot write or erase it', async () => {
  const { dbApi } = await import('../../db.js');
  const owner = createTestAccount(dbApi, { email: 'mission-owner@example.com', name: 'Owner', passwordHash: 'x', isSuperadmin: false });
  dbApi.uiLayoutSet(owner.id, 'v2.guarded.widgets', JSON.stringify([{ id: 'kept' }]));
  const guarded = express();
  guarded.use(express.json());
  guarded.use((req, _res, next) => {
    req.auth = { kind: 'api-token', user: owner, isSuperadmin: false, missionId: 'm-agent', permissions: [] };
    next();
  });
  registerRoutes(guarded);
  const srv = guarded.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const at = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const read = await fetch(`${at}/api/layout?scope=v2.guarded.widgets`);
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json() as { layout: unknown }).layout, [{ id: 'kept' }]);

    const put = await fetch(`${at}/api/layout?scope=v2.guarded.widgets`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout: [{ id: 'agent' }] }),
    });
    assert.equal(put.status, 403);
    assert.match(((await put.json()) as { hint: string }).hint, /widgets_propose/);
    const del = await fetch(`${at}/api/layout?scope=v2.guarded.widgets`, { method: 'DELETE' });
    assert.equal(del.status, 403);
    assert.equal(dbApi.uiLayoutGet(owner.id, 'v2.guarded.widgets')?.value, JSON.stringify([{ id: 'kept' }]));
  } finally {
    srv.close();
  }
});
