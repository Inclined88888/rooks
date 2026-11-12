import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dbApi } from './db.js';
import { createBrowserProfile } from './browser-profiles.js';
import { canonicalCredentialOrigin, deleteBrowserCredential, fillBrowserCredential, listBrowserCredentials, saveBrowserCredentialFromPage, upsertBrowserCredential } from './browser-credentials.js';
import { rekeyVault, resetRotationCheck } from './secrets/store.js';
import { resetMasterKeyCache, resolveMasterKey } from './secrets/key.js';
import { SECRET_KEY_FILE } from './paths.js';
import { redactText, redactedValues } from './secrets/redact.js';

resolveMasterKey({ keyring: null });
const newProfile = () => createBrowserProfile({ name: 'Private browser', owner_user_id: randomUUID() });

test('browser usernames and passwords are encrypted at rest and omitted from every CRUD response', () => {
  const profile = newProfile();
  const username = `test-${randomUUID()}@example.com`;
  const password = `private-${randomUUID()}`;
  const row = upsertBrowserCredential(profile, { origin: 'https://EXAMPLE.com:443/login?session=test', username, password });
  assert.equal(row.origin, 'https://example.com');
  assert.deepEqual(Object.keys(row).sort(), ['createdAt','id','label','origin','profileId','updatedAt','usernameHint']);
  const publicData = JSON.stringify([row, listBrowserCredentials(profile)]);
  assert.ok(!publicData.includes(username));
  assert.ok(!publicData.includes(password));
  const stored = dbApi.pluginKvList('@rooks/browser-embedded').filter(({ key }) => key.includes(profile.id));
  assert.equal(stored.length, 2);
  assert.ok(stored.some(({ value }) => value.startsWith('enc:1:')));
  assert.ok(!JSON.stringify(stored).includes(username));
  assert.ok(!JSON.stringify(stored).includes(password));
  assert.equal(upsertBrowserCredential(profile, { origin: row.origin, username, password: `${password}-updated` }).id, row.id);
  assert.equal(listBrowserCredentials(profile).length, 1);
  assert.equal(deleteBrowserCredential(profile, row.id), true);
  assert.equal(listBrowserCredentials(profile).length, 0);
  assert.equal(dbApi.pluginKvList('@rooks/browser-embedded').filter(({ key }) => key.includes(profile.id)).length, 0);
});

test('credentials cannot be moved to another profile or owner and provider errors never echo passwords', async () => {
  const profile = newProfile(); const other = newProfile();
  const password = `do-not-return-${randomUUID()}`;
  const row = upsertBrowserCredential(profile, { origin: 'https://client.example', username: 'publisher', password });
  let called = false;
  await assert.rejects(fillBrowserCredential(other, row.id, async () => { called = true; return { filled: true }; }), /not found/);
  assert.equal(called, false);
  await assert.rejects(fillBrowserCredential({ ...profile, owner_user_id: other.owner_user_id }, row.id), /vault is unavailable/);
  await assert.rejects(fillBrowserCredential(profile, row.id, async () => { throw new Error(password); }), (error: Error) => !error.message.includes(password) && /refused/.test(error.message));
});

test('filling sends only the bound profile and exact origin to the atomic provider and returns no credential data', async () => {
  const profile = newProfile();
  const row = upsertBrowserCredential(profile, { origin: 'https://client.example:8443/login', username: 'publisher', password: 'private-password' });
  const result = await fillBrowserCredential(profile, row.id, async (id, command) => {
    assert.equal(id, profile.id);
    assert.deepEqual(command, { action: 'fillCredential', origin: 'https://client.example:8443', credentialId: row.id, username: 'publisher', password: 'private-password', commandActor: 'agent' });
    return { filled: true, password: 'provider-must-not-leak-this' };
  });
  assert.deepEqual(result, { filled: true });
  const key = `browser-credentials/${profile.id}/${row.id}`;
  dbApi.pluginKvSet('@rooks/browser-embedded', key, JSON.stringify({ ...row, origin: 'https://client.example.evil.test' }));
  let called = false;
  await assert.rejects(fillBrowserCredential(profile, row.id, async () => { called = true; return { filled: true }; }), /encrypted data is invalid/);
  assert.equal(called, false, 'metadata tampering must not retarget an encrypted password');
  dbApi.pluginKvSet('@rooks/browser-embedded', key, JSON.stringify(row));
});

test('explicit save-from-page uses only the capture command and returns metadata', async () => {
  const profile = newProfile();
  const response = await saveBrowserCredentialFromPage(profile, 'CMS', async (id, command) => {
    assert.equal(id, profile.id);
    assert.deepEqual(command, { action: 'captureCredential', commandActor: 'agent' });
    return { origin: 'https://cms.example', username: 'editor', password: 'saved-from-form' };
  });
  assert.equal(response.credential.label, 'CMS');
  assert.ok(!JSON.stringify(response).includes('saved-from-form'));
  await assert.rejects(saveBrowserCredentialFromPage(profile, undefined, async () => ({ error: 'No form' })), /no supported login form/);
});

test('credential origins canonicalize exact authority and reject userinfo or non-web schemes', () => {
  assert.equal(canonicalCredentialOrigin('https://EXAMPLE.com:443/login'), 'https://example.com');
  assert.notEqual(canonicalCredentialOrigin('http://example.com'), canonicalCredentialOrigin('https://example.com'));
  assert.notEqual(canonicalCredentialOrigin('https://example.com:8443'), canonicalCredentialOrigin('https://example.com'));
  assert.notEqual(canonicalCredentialOrigin('https://example.com.evil.test'), canonicalCredentialOrigin('https://example.com'));
  for (const value of ['https://example.com@evil.test', 'file:///tmp/password', 'javascript:alert(1)', 'data:text/html,login', 'not a URL']) assert.throws(() => canonicalCredentialOrigin(value), /HTTP or HTTPS/);
});

test('browser vault writes redact credentials before transcript storage and invalidate caches on replacement, rotation and deletion', () => {
  const profile = newProfile(); const mission = randomUUID();
  const username = `private-username-${randomUUID()}`; const password = randomUUID();
  const rotatedPassword = randomUUID();
  dbApi.createMission(mission, 'credential-redaction-agent', 'test');
  assert.equal(redactText(password), password, 'warm the cache before the first browser secret');
  const row = upsertBrowserCredential(profile, { origin: 'https://client.example', username, password });
  dbApi.insertEvent(mission, 'assistant', { text: `Login ${username}: ${password}` });
  assert.equal(JSON.parse(dbApi.listEvents(mission)[0].payload).text, `Login ${username}: ***`);
  upsertBrowserCredential(profile, { id: row.id, origin: row.origin, username, password: rotatedPassword });
  assert.equal(redactText(rotatedPassword), '***');
  assert.equal(redactText(password), password, 'the replacement invalidates cached old values');
  const cached = redactedValues();
  rekeyVault();
  assert.notEqual(redactedValues(), cached, 'rotation invalidates the memoized values');
  assert.equal(redactText(rotatedPassword), '***', 'rotation retains trace protection');
  deleteBrowserCredential(profile, row.id);
  assert.equal(redactText(rotatedPassword), rotatedPassword);
  assert.equal(redactText(username), username);
});

test('browser-only vault rows survive rotation and prevent regenerating a lost master key', async () => {
  const profile = newProfile();
  const row = upsertBrowserCredential(profile, { origin: 'https://rotation.example', username: 'user', password: 'rotation-password' });
  const before = dbApi.pluginKvGet('@rooks/browser-embedded', `@settings/browser-credentials/${profile.id}/${row.id}`);
  assert.ok(rekeyVault().rotated > 0);
  const after = dbApi.pluginKvGet('@rooks/browser-embedded', `@settings/browser-credentials/${profile.id}/${row.id}`);
  assert.notEqual(before, after);
  await fillBrowserCredential(profile, row.id, async (_id, command) => {
    assert.equal(command.password, 'rotation-password'); return { filled: true };
  });
  const key = readFileSync(SECRET_KEY_FILE);
  unlinkSync(SECRET_KEY_FILE); resetMasterKeyCache(); resetRotationCheck();
  try {
    assert.throws(() => upsertBrowserCredential(newProfile(), { origin: 'https://new.example', username: 'u', password: 'p' }), /vault is unavailable/);
    assert.equal(existsSync(SECRET_KEY_FILE), false, 'a missing key must not be replaced while browser credentials exist');
  } finally {
    writeFileSync(SECRET_KEY_FILE, key, { mode: 0o600 }); resetMasterKeyCache(); resetRotationCheck();
  }
});
