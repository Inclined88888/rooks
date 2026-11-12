import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { pluginDeclaringHost, recordDictationDeclarations, refusedDeclaredHost } from './destination';

test.beforeEach(() => {
  recordDictationDeclarations([
    {
      id: 'acme',
      dictation: {
        engines: [
          { id: 'cloud', runtime: 'page', egress: ['api.acme.com', '*.voice.example'] },
          { id: 'server', runtime: 'daemon', egress: ['daemon-side.example'] },
        ],
        models: null,
      },
    },
  ]);
});

test('a host is attributed to the plugin whose page engine declares it', () => {
  assert.equal(pluginDeclaringHost('api.acme.com'), 'acme');
  assert.equal(pluginDeclaringHost('API.ACME.COM'), 'acme');
  assert.equal(pluginDeclaringHost('eu.voice.example'), 'acme');
  // As in a CSP source: `*.name` covers subdomains, not the name itself.
  assert.equal(pluginDeclaringHost('voice.example'), null);
  assert.equal(pluginDeclaringHost('evilvoice.example'), null);
  // A daemon engine's hosts are reached by its host half, never by the window.
  assert.equal(pluginDeclaringHost('daemon-side.example'), null);
  assert.equal(pluginDeclaringHost('elsewhere.example'), null);
});

test('only a refused TLS connection to a declared host asks for a reload', () => {
  assert.deepEqual(refusedDeclaredHost('connect-src', 'https://api.acme.com/v1/stream'), { host: 'api.acme.com', pluginId: 'acme' });
  assert.deepEqual(refusedDeclaredHost('connect-src', 'wss://eu.voice.example/ws'), { host: 'eu.voice.example', pluginId: 'acme' });
  assert.equal(refusedDeclaredHost('connect-src', 'http://api.acme.com/'), null, 'plain HTTP is never allowed, a reload would not help');
  assert.equal(refusedDeclaredHost('img-src', 'https://api.acme.com/pixel'), null);
  assert.equal(refusedDeclaredHost('connect-src', 'https://exfil.example/'), null);
  assert.equal(refusedDeclaredHost('connect-src', 'inline'), null);
  recordDictationDeclarations([]);
  assert.equal(refusedDeclaredHost('connect-src', 'https://api.acme.com/'), null, 'uninstalled: nothing to reload for');
});
