/**
 * `broker_spec` validation and the host allowlist (`docs/SECRETS-VAULT.md`
 * §6.2, invariant §12.7). No `ROOKS_HOME` needed: nothing here touches the
 * filesystem or the database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrokerSpecError, isHostAllowed, parseBrokerSpec, renderInjectedHeader } from './broker-spec.js';

const HTTP_SPEC = {
  type: 'http',
  hosts: ['api.github.com'],
  inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{value}}' },
};

test('a well-formed http spec parses, from an object and from its JSON text', () => {
  const fromObject = parseBrokerSpec(HTTP_SPEC);
  const fromText = parseBrokerSpec(JSON.stringify(HTTP_SPEC));
  assert.deepEqual(fromObject, fromText);
  assert.equal(fromObject.type, 'http');
  assert.deepEqual(fromObject.hosts, ['api.github.com']);
});

test('an empty `hosts` is refused — the allowlist is structural, not a setting', () => {
  assert.throws(() => parseBrokerSpec({ ...HTTP_SPEC, hosts: [] }), BrokerSpecError);
  assert.throws(() => parseBrokerSpec({ ...HTTP_SPEC, hosts: undefined }), BrokerSpecError);
  assert.throws(() => parseBrokerSpec({ type: 'git' }), BrokerSpecError);
});

test('a host that is not a bare hostname is refused (no scheme, port, path or userinfo)', () => {
  for (const host of ['https://api.github.com', 'api.github.com:443', 'api.github.com/x', 'user@api.github.com', '', '*']) {
    assert.throws(() => parseBrokerSpec({ ...HTTP_SPEC, hosts: [host] }), BrokerSpecError, host);
  }
});

test('the injection must be a header carrying {{value}}', () => {
  assert.throws(() => parseBrokerSpec({ ...HTTP_SPEC, inject: undefined }), BrokerSpecError);
  assert.throws(
    () => parseBrokerSpec({ ...HTTP_SPEC, inject: { kind: 'query', name: 'token', template: '{{value}}' } }),
    BrokerSpecError,
  );
  assert.throws(
    () => parseBrokerSpec({ ...HTTP_SPEC, inject: { kind: 'header', name: 'Authorization', template: 'Bearer static' } }),
    BrokerSpecError,
  );
  assert.throws(
    () => parseBrokerSpec({ ...HTTP_SPEC, inject: { kind: 'header', name: 'Bad Header: x', template: '{{value}}' } }),
    BrokerSpecError,
  );
});

test('an unknown type, a non-object and invalid JSON are all refused', () => {
  assert.throws(() => parseBrokerSpec({ type: 'ftp', hosts: ['x.com'] }), BrokerSpecError);
  assert.throws(() => parseBrokerSpec('{not json'), BrokerSpecError);
  assert.throws(() => parseBrokerSpec([HTTP_SPEC]), BrokerSpecError);
  assert.throws(() => parseBrokerSpec(null), BrokerSpecError);
});

test('the allowlist matches an exact host or a subdomain — never a substring', () => {
  const hosts = ['github.com'];
  assert.equal(isHostAllowed('github.com', hosts), true);
  assert.equal(isHostAllowed('api.github.com', hosts), true);
  assert.equal(isHostAllowed('GitHub.COM', hosts), true);

  // The attack the `'.' + allowed` form exists to stop: a suffix as a string,
  // a completely different registrable domain in reality.
  assert.equal(isHostAllowed('api.github.com.evil.example', hosts), false);
  assert.equal(isHostAllowed('evilgithub.com', hosts), false);
  assert.equal(isHostAllowed('github.com.evil.example', hosts), false);
  assert.equal(isHostAllowed('evil.example', hosts), false);
});

test('an empty allowlist denies everything rather than allowing everything', () => {
  assert.equal(isHostAllowed('api.github.com', []), false);
  assert.equal(isHostAllowed('api.github.com', ['']), false);
  assert.equal(isHostAllowed('', ['github.com']), false);
});

test('the rendered header carries the value, and only where the template says', () => {
  const spec = parseBrokerSpec(HTTP_SPEC);
  assert.equal(spec.type, 'http');
  if (spec.type !== 'http') return;
  assert.deepEqual(renderInjectedHeader(spec, 'ghp_secret'), { name: 'Authorization', value: 'Bearer ghp_secret' });
});

test('a git spec keeps its optional username and requires its hosts', () => {
  const spec = parseBrokerSpec({ type: 'git', hosts: ['github.com'], username: 'x-access-token' });
  assert.deepEqual(spec, { type: 'git', hosts: ['github.com'], username: 'x-access-token' });
  assert.deepEqual(parseBrokerSpec({ type: 'git', hosts: ['github.com'] }), { type: 'git', hosts: ['github.com'] });
  assert.throws(() => parseBrokerSpec({ type: 'git', hosts: ['github.com'], username: 42 }), BrokerSpecError);
});
