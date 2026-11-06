/**
 * AUDIT-CLI-MCP-PERMISSIONS §3.3-3.5 — every right-check 403 now carries an
 * exploitable body (`code` / `permission` / `reason` / `hint` / `caller`).
 *
 * Two historical invariants must hold while the body gets richer: an
 * anonymous caller still receives `401 { error: 'unauthorized' }`, and a
 * property (owner-scope) 404 is never downgraded to a 403 — the helper only
 * ever emits 403, so nothing it touches can turn a hidden row into a signal.
 *
 * `forbiddenBody` is pure and needs no database; only the `forbidden` case
 * writes an `authz.denied` audit row, hence the temp `TIMON_HOME`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { RequestAuth, ForbiddenBody } from './identity.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-forbidden-body-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.on('exit', () => rmSync(process.env.TIMON_HOME!, { recursive: true, force: true }));

const { forbiddenBody, forbidden, rejectIfNotDaemonToken } =
  await import('./identity.js');

/** An auth snapshot with only the fields the classifier reads. */
function auth(partial: Partial<RequestAuth> & Pick<RequestAuth, 'kind'>): RequestAuth {
  return { user: null, isSuperadmin: false, ...partial };
}

function reqWith(a?: RequestAuth): Request {
  // `forbidden` audits the peer address; a bare fake needs a loopback socket.
  return { auth: a, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
}

/** A `Response` that records what was sent, without a socket behind it. */
function captureRes(): { res: Response; statusCode: number; body: unknown } {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return {
    res: res as unknown as Response,
    get statusCode() { return state.statusCode; },
    get body() { return state.body; },
  };
}

// `users:manage` is deliberately NOT in `MISSION_TOKEN_PERMISSIONS`.
const OUTSIDE_CAP = 'users:manage';
// `agents:manage` IS in the cap, so the account (not the cap) is the blocker.
const INSIDE_CAP = 'agents:manage';

test('a mission token asking for something outside its cap → not_in_mission_cap', () => {
  const body = forbiddenBody(
    reqWith(auth({ kind: 'api-token', permissions: ['kanban:read'], missionId: 'm1' })),
    { kind: 'permission', permission: OUTSIDE_CAP },
  );
  assert.equal(body.error, 'forbidden');
  assert.equal(body.code, 'not_in_mission_cap');
  assert.equal(body.permission, OUTSIDE_CAP);
  assert.equal(body.caller, 'mission');
  assert.match(body.reason, /users:manage/);
  assert.equal(typeof body.hint, 'string');
  // The reason cites only what the caller asked for, never the account's rights.
  assert.doesNotMatch(body.reason, /kanban:read/);
});

test('an ownerless mission (system actor) inside the cap → mission_without_owner, outside it stays not_in_mission_cap', () => {
  const orphan = reqWith(auth({
    kind: 'api-token', permissions: [], missionId: 'm1', actorId: 'system',
  }));
  const inCap = forbiddenBody(orphan, { kind: 'permission', permission: INSIDE_CAP });
  assert.equal(inCap.code, 'mission_without_owner');
  assert.equal(inCap.reason, 'this mission has no owning account');
  assert.equal(inCap.hint, 'relaunch it from your account');
  // A relaunch would not lift an out-of-cap refusal: no misleading hint.
  const outside = forbiddenBody(orphan, { kind: 'permission', permission: OUTSIDE_CAP });
  assert.equal(outside.code, 'not_in_mission_cap');
  assert.doesNotMatch(String(outside.hint), /relaunch/);
});

test('a mission token lacking a capped permission → account_lacks_permission', () => {
  const body = forbiddenBody(
    reqWith(auth({ kind: 'api-token', permissions: ['kanban:read'], missionId: 'm1' })),
    { kind: 'permission', permission: INSIDE_CAP },
  );
  assert.equal(body.code, 'account_lacks_permission');
  assert.equal(body.permission, INSIDE_CAP);
  assert.equal(body.caller, 'mission');
  assert.match(body.reason, /agents:manage/);
});

test('a signed-in non-superadmin lacking the permission → account_lacks_permission', () => {
  const body = forbiddenBody(
    reqWith(auth({ kind: 'session', isSuperadmin: false })),
    { kind: 'permission', permission: INSIDE_CAP },
  );
  assert.equal(body.code, 'account_lacks_permission');
  assert.equal(body.caller, 'session');
});

test('an operator-only refusal names the caller and never leaks a right', () => {
  // daemon-token → the "operator" caller.
  const operator = forbiddenBody(
    reqWith(auth({ kind: 'daemon-token', isSuperadmin: true })),
    { kind: 'operator' },
  );
  assert.equal(operator.code, 'operator_only');
  assert.equal(operator.caller, 'operator');
  assert.equal(operator.permission, null);

  // The same route reached from a session keeps the code, caller becomes session.
  const session = forbiddenBody(
    reqWith(auth({ kind: 'session', isSuperadmin: false })),
    { kind: 'operator' },
  );
  assert.equal(session.code, 'operator_only');
  assert.equal(session.caller, 'session');
});

test('an anonymous caller still gets 401, unchanged', () => {
  const captured = captureRes();
  const handled = rejectIfNotDaemonToken(reqWith(), captured.res);
  assert.equal(handled, true);
  assert.equal(captured.statusCode, 401);
  assert.deepEqual(captured.body, { error: 'unauthorized' });
});

test('the helper sends 403 with a full body and never a 404', () => {
  const captured = captureRes();
  const handled = forbidden(
    reqWith(auth({ kind: 'api-token', permissions: ['kanban:read'] })),
    captured.res,
    { kind: 'permission', permission: OUTSIDE_CAP },
  );
  assert.equal(handled, true);
  assert.equal(captured.statusCode, 403);
  const parsed = captured.body as ForbiddenBody;
  assert.equal(parsed.error, 'forbidden');
  assert.equal(typeof parsed.code, 'string');
  assert.equal(typeof parsed.reason, 'string');
  assert.ok(parsed.hint === null || typeof parsed.hint === 'string');
  assert.ok(['mission', 'session', 'operator'].includes(parsed.caller));
});

test('a scope refusal keeps the caller-sent reason and a stable code', () => {
  const body = forbiddenBody(
    reqWith(auth({ kind: 'api-token', permissions: ['kanban:read'], missionId: 'm1' })),
    { kind: 'scope', reason: 'mission_id differs from the mission this token belongs to' },
  );
  assert.equal(body.error, 'forbidden');
  assert.equal(body.code, 'out_of_scope');
  assert.equal(body.permission, null);
  assert.equal(body.caller, 'mission');
  assert.match(body.reason, /mission_id differs/);
  // The body never names another mission or the token's own rights.
  assert.doesNotMatch(JSON.stringify(body), /m1|kanban:read/);
});

test('an override refusal stays a 403 `forbidden` with the reason', () => {
  const body = forbiddenBody(
    reqWith(auth({ kind: 'api-token', permissions: [], missionId: 'm1' })),
    { kind: 'override', reason: 'permission_mode above the caller level' },
  );
  assert.equal(body.error, 'forbidden');
  assert.equal(body.code, 'override_denied');
  assert.equal(body.reason, 'permission_mode above the caller level');
});

test('a rejectUnlessAny refusal lists the wanted permissions, nothing else', () => {
  const body = forbiddenBody(
    reqWith(auth({ kind: 'session', isSuperadmin: false })),
    { kind: 'permission', permission: ['secrets:broker', 'secrets:manage'] },
  );
  assert.deepEqual(body.permission, ['secrets:broker', 'secrets:manage']);
  assert.match(body.reason, /secrets:broker or secrets:manage/);
});
