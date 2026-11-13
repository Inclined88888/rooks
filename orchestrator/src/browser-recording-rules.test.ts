import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as daemon from './browser-recording-rules.js';
import { RECORDING_STORE_MAX_STEPS, sanitizeRecording } from './browser-recording-rules.js';

const DESKTOP_URL = new URL('../../desktop/src/native-browser-recorder.ts', import.meta.url);
// The two packages are built apart and copy this rule: read the desktop's own.
const desktop = await import(DESKTOP_URL.href) as typeof import('../../desktop/src/native-browser-recorder.js');

test('the daemon copy of the secret rule is the desktop source, verbatim', () => {
  const own = readFileSync(new URL('./browser-recording-rules.ts', import.meta.url), 'utf8');
  const copy = own.slice(own.indexOf('\n', own.indexOf('// --- copied from')) + 1, own.indexOf('// --- end of copy'));
  const source = readFileSync(DESKTOP_URL, 'utf8');
  const [constants, ...functions] = copy.split('\n\n');
  assert.ok(source.includes(constants!), 'secret constants differ from the desktop');
  assert.ok(source.includes(functions.join('\n\n')), 'masking functions differ from the desktop');
  assert.equal(daemon.SECRET_AUTOCOMPLETE_PATTERN, desktop.SECRET_AUTOCOMPLETE_PATTERN);
  assert.deepEqual(daemon.SECRET_INPUT_TYPES, desktop.SECRET_INPUT_TYPES);
  assert.deepEqual(daemon.SECRET_AUTOCOMPLETE_TOKENS, desktop.SECRET_AUTOCOMPLETE_TOKENS);
});

test('daemon and desktop give the same answers on the same corpus', () => {
  const fields: Array<[string, string]> = [['password', ''], ['PASSWORD', ''], ['text', 'username current-password'],
    ['text', 'section-login one-time-code'], ['text', 'cc-number'], ['text', 'username email'], ['', ''], ['email', 'new-password']];
  for (const [type, autocomplete] of fields) {
    assert.equal(daemon.isSecretField(type, autocomplete), desktop.isSecretField(type, autocomplete), `${type}/${autocomplete}`);
    assert.equal(daemon.secretKindOf(type, autocomplete), desktop.secretKindOf(type, autocomplete));
    assert.equal(daemon.maskValue('hunter2', type, autocomplete, 'Pass'), desktop.maskValue('hunter2', type, autocomplete, 'Pass'));
  }
  const values = ['sk-proj-abcdefghijklmnop1234', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
    '4111 1111 1111 1111', '4111 1111 1111 1112', 'hello world', 'aZ9$kL2@pQ7#mN4!xR8%', '123e4567-e89b-12d3-a456-426614174000', 'ada@example.com'];
  for (const value of values) assert.equal(daemon.detectSecret(value), desktop.detectSecret(value), value);
  const urls = ['https://a.example/cb?code=abc&state=1', 'https://a.example/#access_token=x&id_token=y', 'https://u:p@a.example/p',
    'https://a.example/reset/aZ9kL2pQ7mN4xR8tY6uI', 'about:blank', 'chrome-error://chromewebdata/', 'https://a.example/plain?q=shoes'];
  for (const url of urls) assert.equal(daemon.maskUrl(url), desktop.maskUrl(url), url);
});

const recording = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1, startedAt: '2026-10-25T10:00:00.000Z', url: 'https://shop.example/login?token=abc', steps,
  truncated: false, stoppedReason: 'user', ...extra,
});

test('a step the desktop failed to mask is masked again before storage', () => {
  const clean = sanitizeRecording(recording([
    { t: 0, type: 'input', tabId: 't1', selector: '#pw', inputType: 'password', name: 'Password', value: 'hunter2' },
    { t: 1, type: 'secret', tabId: 't1', selector: '#otp', secret: 'otp', name: 'Code', value: '123456' },
    { t: 2, type: 'secret', tabId: 't1', selector: '#pw', secret: 'password', value: '{SECRET:pw}' },
    { t: 3, type: 'navigate', tabId: 't1', url: 'https://shop.example/cb?code=s3cr3t#access_token=x' },
    { t: 4, type: 'input', tabId: 't1', selector: '#q', inputType: 'text', name: 'Search', value: 'shoes' },
    { t: 5, type: 'input', tabId: 't1', selector: '#note', inputType: 'text', value: 'ghp_abcdefghijklmnopqrstuvwxyz0123' },
    { t: 6, type: 'click', tabId: 't1', selector: 'button', text: 'Pay' },
  ]));
  assert.ok(clean);
  const text = JSON.stringify(clean);
  for (const secret of ['hunter2', '123456', 's3cr3t', 'access_token=x', 'token=abc']) assert.ok(!text.includes(secret), secret);
  const [pw, otp, kept, nav, search, note, click] = clean.steps;
  assert.deepEqual([pw!.type, pw!.secret, pw!.value], ['secret', 'password', '{SECRET:Password}']);
  assert.deepEqual([otp!.type, otp!.secret, otp!.value], ['secret', 'otp', '{SECRET:Code}']);
  assert.equal(kept!.value, '{SECRET:pw}', 'a placeholder is not wrapped again');
  assert.match(nav!.url!, /code=\{SECRET:code\}/);
  assert.equal(search!.value, 'shoes');
  assert.equal(search!.flagged, undefined);
  assert.equal(note!.flagged, 'api-key');
  assert.equal(click!.text, 'Pay');
  assert.deepEqual(clean.steps.map((step) => step.n), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(clean.url, 'https://shop.example/login?token={SECRET:token}');
});

test('malformed, internal and unknown steps are dropped; a malformed recording is refused', () => {
  const clean = sanitizeRecording(recording([
    { t: 0, type: 'navigate', tabId: 't1', url: 'about:blank' },
    { t: 0, type: 'navigate', tabId: 't1', url: 'devtools://devtools/inspector.html' },
    { t: 1, type: 'teleport', tabId: 't1' },
    { t: -1, type: 'click', tabId: 't1' },
    { t: 'soon', type: 'click', tabId: 't1' },
    'not a step',
    null,
    { t: 2, type: 'credential', tabId: 't1', origin: 'javascript:alert(1)' },
    { t: 3, type: 'credential', tabId: 't1', origin: 'https://login.example/path?x=1', credentialId: 'bc-1' },
    { t: 4, type: 'click', tabId: 't1', selector: '#go', extra: 'ignored' },
  ]));
  assert.ok(clean);
  assert.deepEqual(clean.steps.map((step) => step.type), ['credential', 'click']);
  assert.equal(clean.steps[0]!.origin, 'https://login.example');
  assert.equal((clean.steps[1] as unknown as Record<string, unknown>).extra, undefined);
  assert.equal(sanitizeRecording({ version: 2, steps: [] }), null);
  assert.equal(sanitizeRecording('nope'), null);
  assert.equal(sanitizeRecording(recording(new Array(2_001).fill({ t: 0, type: 'click', tabId: 't' }))), null);
});

test('the store keeps 1 000 steps and 1 MB at most, and says it truncated', () => {
  const many = Array.from({ length: 1_500 }, (_, i) => ({ t: i, type: 'click', tabId: 't1', selector: `#b${i}` }));
  const capped = sanitizeRecording(recording(many))!;
  assert.equal(capped.steps.length, RECORDING_STORE_MAX_STEPS);
  assert.equal(capped.truncated, true);
  const big = Array.from({ length: 1_000 }, (_, i) => ({ t: i, type: 'input', tabId: 't1', selector: 'x'.repeat(500), name: 'n'.repeat(120), value: 'v'.repeat(500) }));
  const bounded = sanitizeRecording(recording(big))!;
  assert.ok(JSON.stringify(bounded.steps).length <= 1_000_000);
  assert.ok(bounded.steps.length < 1_000);
  assert.equal(bounded.truncated, true);
});
