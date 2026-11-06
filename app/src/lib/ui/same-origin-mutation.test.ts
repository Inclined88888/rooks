import assert from 'node:assert/strict';
import test from 'node:test';
import { foreignMutation } from './same-origin-mutation';

const h = (init: Record<string, string>) => new Headers(init);

test('a sandboxed document (opaque origin) cannot answer or close a card through the app', () => {
  assert.equal(foreignMutation(h({ 'sec-fetch-site': 'cross-site', origin: 'null', host: 'timon.local:3101' })), true);
  // Without Fetch Metadata (an older browser), the opaque origin is refused on its own.
  assert.equal(foreignMutation(h({ origin: 'null', host: 'timon.local:3101' })), true);
  assert.equal(foreignMutation(h({ 'sec-fetch-site': 'same-site', host: 'timon.local:3101' })), true, 'a sibling subdomain is not the app');
  assert.equal(foreignMutation(h({ origin: 'https://evil.example', host: 'timon.local:3101' })), true);
  assert.equal(foreignMutation(h({ origin: 'not a url', host: 'timon.local:3101' })), true);
});

test('the Timon page itself goes through', () => {
  assert.equal(foreignMutation(h({ 'sec-fetch-site': 'same-origin', origin: 'http://timon.local:3101', host: 'timon.local:3101' })), false);
  assert.equal(foreignMutation(h({ origin: 'http://timon.local:3101', host: 'timon.local:3101' })), false);
  assert.equal(foreignMutation(h({ host: 'timon.local:3101' })), false, 'no browser header: no browser cookie either');
});
