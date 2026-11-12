/**
 * C12 — which dialect serves an API protocol for an endpoint the user typed in. The form used to carry a
 * table (`anthropic → claude`, `openai-responses → codex`); the dialects declare the protocol they serve now,
 * and the choice must not depend on who loaded first, nor hand the user's key to a stranger's CLI.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { registerProvider, dialectForProtocol, protocolOfDialect } = await import('./registry.js');
const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

type Definition = Parameters<typeof registerProvider>[1];

function definition(id: string, protocols: Array<'anthropic' | 'openai-responses'>): Definition {
  return {
    id,
    transport: { kind: 'process-per-turn' },
    codec: { kind: 'lines', parseLine: () => [], extractSessionId: () => null, writeUserInput: () => undefined },
    session: { store: 'per-mission', resumable: false },
    permission: { model: 'sandbox' },
    limits: { reporting: 'textual' },
    mcp: { rooks: true },
    declares: { protocols, binary: { names: [id] } },
    launch: async () => ({ cmd: id, args: [], env: {}, initialStdin: null }),
  } as Definition;
}

test('the release provider is picked by id, and an untrusted claim is ignored', () => {
  assert.equal(dialectForProtocol('anthropic'), 'claude');
  const off = registerProvider('stranger', definition('acme-anthropic', ['anthropic']), { trusted: false, authorizedBinaries: ['acme-anthropic', 'aaa-responses'] });
  const offTrusted = registerProvider('release', definition('zzz-anthropic', ['anthropic']), { trusted: true, authorizedBinaries: ['zzz-anthropic', 'bbb-responses', 'ccc-responses'] });
  try {
    assert.equal(dialectForProtocol('anthropic'), 'claude', 'lowest trusted id wins');
    assert.equal(protocolOfDialect('acme-anthropic'), null, 'a stranger\'s dialect is not one the form can pick');
    assert.equal(protocolOfDialect('zzz-anthropic'), 'anthropic');
  } finally {
    off();
    offTrusted();
  }
});

test('with no compiled-in dialect, a trusted one is chosen by id; a stranger\'s is never chosen', () => {
  const stranger = registerProvider('stranger', definition('aaa-responses', ['openai-responses']), { trusted: false, authorizedBinaries: ['acme-anthropic', 'aaa-responses'] });
  const b = registerProvider('release', definition('bbb-responses', ['openai-responses']), { trusted: true, authorizedBinaries: ['zzz-anthropic', 'bbb-responses', 'ccc-responses'] });
  const a = registerProvider('release', definition('ccc-responses', ['openai-responses']), { trusted: true, authorizedBinaries: ['zzz-anthropic', 'bbb-responses', 'ccc-responses'] });
  try {
    const chosen = dialectForProtocol('openai-responses');
    assert.ok(chosen !== 'aaa-responses', 'a third-party dialect never receives the user\'s key');
    assert.ok(['codex', 'bbb-responses'].includes(chosen ?? ''), chosen ?? 'none');
  } finally {
    stranger();
    a();
    b();
  }
});
