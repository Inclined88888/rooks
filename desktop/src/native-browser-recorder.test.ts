import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECORDING_IDLE_MS, RECORDING_MAX_PAGE_EVENTS_PER_SECOND, RECORDING_MAX_STEPS, RecordingSession, SECRET_AUTOCOMPLETE_PATTERN,
  acceptsPageEventSize, buildSteps, credentialStep, detectSecret, isRecordableUrl, isSecretField, isSecretPlaceholder,
  isSensitiveUrlParam, luhn, maskUrl, maskValue, navigationStep, normalizePageEvent, selectorFor, type RecordingStep,
} from './native-browser-recorder.js';

// Ported from Hermes workflow-record tests/test_recording.py (MIT), then extended for Rooks's own
// leaks: token-bearing URLs, the heuristic detector, the step tags of the tab model.

const at = { t: 1_753_500_000_000, tabId: 'tab-a' };
const json = (value: unknown) => JSON.stringify(value);

test('a password input type is masked and the raw value never appears', () => {
  assert.equal(maskValue('hunter2', 'password', '', 'pw'), '{SECRET:pw}');
  assert.ok(!maskValue('hunter2', 'password', '', 'login-password').includes('hunter2'));
});

test('each secret autocomplete token is masked on its own', () => {
  for (const token of ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc']) {
    assert.equal(maskValue('s3cr3t', '', token, 'f'), '{SECRET:f}', token);
  }
});

test('a secret autocomplete token inside a token list is masked', () => {
  for (const list of ['username current-password', 'section-login new-password', 'one-time-code username',
    'cc-number cc-csc', '  current-password  ', 'Current-Password', 'section-login one-time-code']) {
    assert.equal(maskValue('s3cr3t', '', list, 'f'), '{SECRET:f}', list);
  }
});

test('a token list without a secret token is not masked', () => {
  for (const list of ['username email', 'current-password-extra', 'shipping address']) {
    assert.equal(maskValue('alice@example.com', '', list, 'user'), 'alice@example.com', list);
  }
});

test('plain values pass through, placeholders are not wrapped twice, a nameless field falls back to its type', () => {
  assert.equal(maskValue('alice@example.com', 'email', '', 'user'), 'alice@example.com');
  assert.equal(maskValue('{SECRET:pw}', 'password', '', 'pw'), '{SECRET:pw}');
  assert.equal(maskValue('x', 'password', '', ''), '{SECRET:password}');
  assert.equal(maskValue('x', 'password', '', '}{evil'), '{SECRET:evil}');
  assert.ok(isSecretPlaceholder('{SECRET:pw}'));
  assert.ok(!isSecretPlaceholder('hunter2'));
  assert.ok(!isSecretPlaceholder(null));
});

test('the secret rule is exported as one pattern source the preload and daemon copy', () => {
  assert.equal(SECRET_AUTOCOMPLETE_PATTERN, '(?:^|\\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc)(?:\\s|$)');
  assert.ok(isSecretField('PASSWORD'));
  assert.ok(isSecretField('text', 'username current-password'));
  assert.ok(!isSecretField('text', 'username'));
});

test('selector fallbacks: recorded selector, then tag and label, then bare tag, never empty', () => {
  assert.equal(selectorFor({ selector: '#login > button', tag: 'button' }), '#login > button');
  const fallback = selectorFor({ selector: '', tag: 'button', text: 'Sign in' });
  assert.ok(fallback.includes('button') && fallback.includes('Sign in'));
  assert.equal(selectorFor({ tag: 'input' }), 'input');
  assert.equal(selectorFor({}), '*');
});

test('page events become tagged steps', () => {
  assert.deepEqual(normalizePageEvent({ type: 'click', selector: '#buy', tag: 'button', role: 'button', name: 'Buy now', text: 'Buy now' }, at),
    { t: at.t, type: 'click', tabId: 'tab-a', selector: '#buy', text: 'Buy now', tag: 'button', role: 'button', name: 'Buy now' });
  assert.deepEqual(normalizePageEvent({ type: 'enter', selector: '#pw' }, at), { t: at.t, type: 'enter', tabId: 'tab-a', selector: '#pw' });
  assert.equal(normalizePageEvent({ type: 'input', selector: '#user', tag: 'input', inputType: 'text', value: 'alice' }, at)?.value, 'alice');
});

test('an input masks a password the page failed to mask, and records it as a secret step', () => {
  const step = normalizePageEvent({ type: 'input', selector: 'input[name=pw]', tag: 'input', inputType: 'password', field: 'pw', value: 'hunter2' }, at)!;
  assert.equal(step.type, 'secret');
  assert.equal(step.secret, 'password');
  assert.equal(step.value, '{SECRET:pw}');
  assert.ok(!json(step).includes('hunter2'));
});

test('a field whose type changed in flight is masked from the autocomplete the host sees', () => {
  // The preload read `text` (a "show password" toggle), but the field still names a secret token.
  const step = normalizePageEvent({ type: 'input', selector: '#otp', tag: 'input', inputType: 'text',
    autocomplete: 'one-time-code', field: 'otp', value: '123456' }, at)!;
  assert.deepEqual([step.type, step.secret, step.value], ['secret', 'otp', '{SECRET:otp}']);
  const card = normalizePageEvent({ type: 'input', tag: 'input', inputType: 'text', autocomplete: 'billing cc-number', value: '4111111111111111' }, at)!;
  assert.deepEqual([card.secret, card.value], ['card', '{SECRET:text}']);
  // The preload flags a field that was a password earlier with a placeholder: kept masked whatever its type now.
  const shown = normalizePageEvent({ type: 'input', tag: 'input', inputType: 'text', field: 'pw', value: '{SECRET:pw}' }, at)!;
  assert.deepEqual([shown.type, shown.value], ['secret', '{SECRET:pw}']);
});

test('a placeholder label from the page cannot carry the value or break the placeholder', () => {
  const step = normalizePageEvent({ type: 'input', tag: 'input', inputType: 'password', field: '{SECRET:x}hunter2', value: 'hunter2' }, at)!;
  assert.ok(isSecretPlaceholder(step.value));
});

test('a click on a filled field never keeps its text', () => {
  for (const event of [
    { tag: 'input', inputType: 'password', text: 'hunter2' },
    { tag: 'input', text: 'hunter2' },
    { tag: 'input', inputType: 'text', text: 'hunter2' },
    { tag: 'textarea', text: 'hunter2' },
    { tag: 'select', text: 'hunter2' },
    { tag: 'div', autocomplete: 'current-password', text: 'hunter2' },
  ]) {
    const step = normalizePageEvent({ type: 'click', ...event }, at)!;
    assert.ok(!json(step).includes('hunter2'), json(event));
    assert.equal(step.text, undefined);
  }
});

test('a click on an input button keeps its label', () => {
  assert.equal(normalizePageEvent({ type: 'click', selector: '#go', tag: 'input', inputType: 'submit', text: 'Sign in' }, at)?.text, 'Sign in');
});

test('unknown events, non-objects and invalid timestamps are dropped', () => {
  assert.equal(normalizePageEvent({ type: 'scroll' }, at), null);
  assert.equal(normalizePageEvent('nope', at), null);
  assert.equal(normalizePageEvent(null, at), null);
  assert.equal(normalizePageEvent(['click'], at), null);
  assert.equal(normalizePageEvent({ type: 'click' }, { t: Number.NaN, tabId: 'tab-a' }), null);
  assert.equal(normalizePageEvent({ type: 'click' }, { t: -1, tabId: 'tab-a' }), null);
});

test('page strings are bounded and oddly typed fields are discarded', () => {
  const step = normalizePageEvent({ type: 'input', tag: 'IN PUT', inputType: { toString: () => 'password' }, value: 'x'.repeat(5000), name: 'n'.repeat(500) }, at)!;
  assert.equal(step.tag, undefined);
  assert.equal(step.inputType, undefined);
  assert.equal(step.value?.length, 500);
  assert.equal(step.name?.length, 120);
  assert.equal(acceptsPageEventSize({ value: 'x'.repeat(9000) }), false);
  assert.equal(acceptsPageEventSize({ value: 'x' }), true);
});

test('file inputs record no value', () => {
  const step = normalizePageEvent({ type: 'input', tag: 'input', inputType: 'file', value: 'C:\\fakepath\\passport.pdf' }, at)!;
  assert.equal(step.value, undefined);
});

test('steps are ordered and rebased to seconds; relative stamps pass through', () => {
  const steps: RecordingStep[] = [
    { t: 1_753_500_002_000, type: 'input', tabId: 'a', selector: '#user', value: 'alice' },
    { t: 1_753_500_001_000, type: 'click', tabId: 'a', selector: '#login', text: 'Login' },
    { t: 1_753_500_003_000, type: 'navigate', tabId: 'a', url: 'https://x.test/home' },
  ];
  const built = buildSteps(steps);
  assert.deepEqual(built.map((step) => step.type), ['click', 'input', 'navigate']);
  assert.deepEqual(built.map((step) => step.t), [0, 1, 2]);
  assert.equal(steps[0]!.t, 1_753_500_002_000, 'the buffer is not mutated');
  assert.deepEqual(buildSteps([{ t: 1, type: 'click', tabId: 'a' }, { t: 2, type: 'click', tabId: 'a' }]).map((step) => step.t), [0, 1]);
  assert.deepEqual(buildSteps([]), []);
});

test('a value committed by the Enter that submits its form comes before the Enter', () => {
  const built = buildSteps([
    { t: 1_000_000_000_000, type: 'enter', tabId: 'a', selector: '#q' },
    { t: 1_000_000_000_004, type: 'input', tabId: 'a', selector: '#q', value: 'shoes' },
  ]);
  assert.deepEqual(built.map((step) => step.type), ['input', 'enter']);
  const otherField = buildSteps([
    { t: 1_000_000_000_000, type: 'enter', tabId: 'a', selector: '#q' },
    { t: 1_000_000_000_004, type: 'input', tabId: 'a', selector: '#other', value: 'x' },
  ]);
  assert.deepEqual(otherField.map((step) => step.type), ['enter', 'input']);
});

test('a recording never contains a raw password', () => {
  const session = new RecordingSession('https://x.test/', () => at.t);
  session.add(normalizePageEvent({ type: 'input', selector: '#pw', tag: 'input', inputType: 'password', field: 'pw', value: 'raw-secret-value' }, at), { page: true });
  session.add(normalizePageEvent({ type: 'click', tag: 'input', inputType: 'password', text: 'raw-secret-value' }, at), { page: true });
  const result = session.result();
  assert.ok(!json(result).includes('raw-secret-value'));
  assert.ok(result.steps.some((step) => step.value === '{SECRET:pw}'));
});

test('top-frame navigations are recorded, internal pages are not', () => {
  assert.deepEqual(navigationStep('https://x.test/next', at), { t: at.t, type: 'navigate', tabId: 'tab-a', url: 'https://x.test/next' });
  for (const url of ['about:blank', 'chrome://newtab', 'devtools://x', 'chrome-error://chromewebdata/', 'file:///etc/passwd', 'data:text/html,x', '', 42]) {
    assert.equal(navigationStep(url, at), null, String(url));
    assert.equal(isRecordableUrl(url), false);
  }
});

test('token-bearing URLs are masked in the query, the fragment, the path and the user info', () => {
  assert.equal(maskUrl('https://app.test/callback?code=4/0AbCdEf&state=xyz'), 'https://app.test/callback?code={SECRET:code}&state=xyz');
  assert.equal(maskUrl('https://app.test/cb#access_token=ya29.secret&token_type=Bearer'), 'https://app.test/cb#{SECRET:fragment}');
  for (const name of ['token', 'access_token', 'id_token', 'refresh_token', 'client_secret', 'X-Amz-Signature', 'X-Amz-Security-Token', 'api_key', 'apiKey', 'reset-token', 'password']) {
    const masked = maskUrl(`https://x.test/?${name}=hunter2value&page=2`);
    assert.ok(!masked.includes('hunter2value'), `${name}: ${masked}`);
    assert.ok(masked.endsWith('&page=2'), masked);
    assert.ok(isSensitiveUrlParam(name), name);
  }
  assert.equal(maskUrl('https://alice:hunter2@x.test/a'), 'https://x.test/a');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.equal(maskUrl(`https://x.test/magic/${jwt}/confirm`), 'https://x.test/magic/{SECRET:path}/confirm');
  assert.equal(maskUrl(`https://x.test/search?q=${jwt}`), 'https://x.test/search?q={SECRET:q}');
  assert.equal(maskUrl(`https://x.test/?next=${encodeURIComponent('https://y.test/?token=abc')}`), 'https://x.test/?next={SECRET:next}');
});

test('ordinary URLs are kept as they are', () => {
  for (const url of ['https://x.test/', 'https://x.test/orders/123e4567-e89b-12d3-a456-426614174000?page=2&sort=asc',
    'https://x.test/docs#section-2', 'https://shop.test/search?q=red+shoes&zipcode=75011', 'https://x.test/app#/settings/profile']) {
    assert.equal(maskUrl(url), url);
  }
  assert.equal(maskUrl('javascript:alert(1)'), '');
});

test('the detector flags keys, JWTs, card numbers and random tokens typed into ordinary fields', () => {
  assert.equal(detectSecret('sk-proj-abcdefghijklmnopqrstuvwx'), 'api-key');
  assert.equal(detectSecret('my token is ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'api-key');
  assert.equal(detectSecret('AKIAIOSFODNN7EXAMPLE'), 'api-key');
  assert.equal(detectSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), 'jwt');
  assert.equal(detectSecret('4111 1111 1111 1111'), 'card-number');
  assert.equal(detectSecret('5500-0000-0000-0004'), 'card-number');
  assert.equal(detectSecret('Zx9#kQ2$vLm8@Rt5^Wp3&Yn7'), 'high-entropy');
  assert.equal(detectSecret('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'), 'high-entropy');
  assert.equal(detectSecret('https://x.test/cb?code=abc'), 'high-entropy');
});

test('the detector leaves ordinary values alone', () => {
  for (const value of ['alice@example.com', 'Paris', 'red shoes size 42', '4111 1111 1111 1112', '0612345678',
    '123e4567-e89b-12d3-a456-426614174000', 'https://x.test/page?id=3', 'firstname.lastname@company-name.example', '{SECRET:pw}', '', 'The quick brown fox jumps over']) {
    assert.equal(detectSecret(value), null, value);
  }
  assert.ok(luhn('4111111111111111'));
  assert.ok(!luhn('4111111111111112'));
});

test('a flagged value is kept for the review but marked', () => {
  const step = normalizePageEvent({ type: 'input', tag: 'input', inputType: 'search', value: 'sk-proj-abcdefghijklmnopqrstuvwx' }, at)!;
  assert.deepEqual([step.type, step.flagged], ['input', 'api-key']);
  const click = normalizePageEvent({ type: 'click', tag: 'code', text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, at)!;
  assert.equal(click.flagged, 'api-key');
});

test('credential steps carry the origin and a well-formed credential id only', () => {
  assert.deepEqual(credentialStep('https://app.test', 'cred_1', at), { t: at.t, type: 'credential', tabId: 'tab-a', origin: 'https://app.test', credentialId: 'cred_1' });
  assert.deepEqual(credentialStep('https://app.test/login?x=1', '../etc', at), { t: at.t, type: 'credential', tabId: 'tab-a', origin: 'https://app.test' });
  assert.equal(credentialStep('file:///x', 'cred_1', at), null);
});

test('a session is bounded in rate, size and idle time', () => {
  let now = at.t;
  const session = new RecordingSession('https://x.test/', () => now);
  const click = () => normalizePageEvent({ type: 'click', tag: 'button', text: 'Go' }, { t: now, tabId: 'a' });
  for (let index = 0; index < RECORDING_MAX_PAGE_EVENTS_PER_SECOND; index++) assert.ok(session.add(click(), { page: true }));
  assert.equal(session.add(click(), { page: true }), false, 'a page hammering the channel is dropped');
  assert.ok(session.add(navigationStep('https://x.test/b', { t: now, tabId: 'a' })), 'host steps are not rate limited');
  now += 1000;
  assert.ok(session.add(click(), { page: true }));
  assert.equal(session.idleRemaining(), RECORDING_IDLE_MS);
  now += RECORDING_IDLE_MS;
  assert.equal(session.idleRemaining(), 0);

  const full = new RecordingSession('', () => now);
  for (let index = 0; index < RECORDING_MAX_STEPS; index++) full.add({ t: now, type: 'click', tabId: 'a' });
  assert.equal(full.count, RECORDING_MAX_STEPS);
  assert.equal(full.active, false);
  assert.equal(full.add({ t: now, type: 'click', tabId: 'a' }), false);
  assert.deepEqual([full.result().truncated, full.result().stoppedReason], [true, 'limit']);
});

test('a stopped session refuses steps and reports why it stopped', () => {
  const session = new RecordingSession('https://x.test/', () => at.t);
  session.stop('idle');
  session.stop('user');
  assert.equal(session.add({ t: at.t, type: 'click', tabId: 'a' }), false);
  assert.deepEqual([session.result().stoppedReason, session.result().steps], ['idle', []]);
  assert.equal(session.result().startedAt, new Date(at.t).toISOString());
});
