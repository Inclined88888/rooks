import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyUiDocumentResolution,
  fetchUiDocument,
  parseUiDocument,
  parseUiDocumentResolved,
  uiDocumentUrl,
} from './ui-documents';

const ID = '0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b';
const EVENT = {
  id: ID, status: 'shown', title: 'Release checklist', origin: { kind: 'agent', id: 'rooks.coder' },
  bridge: 'rooks', height: 320, expectsReply: false, createdAt: 1_760_000_000_000,
};

test('a ui_document event payload becomes a block', () => {
  assert.deepEqual(parseUiDocument(EVENT), {
    id: ID, title: 'Release checklist', status: 'shown', origin: { kind: 'agent', id: 'rooks.coder' },
    bridge: 'rooks', height: 320, expectsReply: false, createdAt: 1_760_000_000_000,
  });
});

test('anything that is not exactly a document is refused', () => {
  assert.equal(parseUiDocument(null), null);
  assert.equal(parseUiDocument({ ...EVENT, id: '../../etc' }), null);
  assert.equal(parseUiDocument({ ...EVENT, status: 'open' }), null);
  assert.equal(parseUiDocument({ ...EVENT, bridge: 'iframe' }), null);
  assert.equal(parseUiDocument({ ...EVENT, title: 'two\nlines' }), null);
  assert.equal(parseUiDocument({ ...EVENT, title: 'x'.repeat(121) }), null);
  assert.equal(parseUiDocument({ ...EVENT, origin: { kind: 'admin', id: 'x' } }), null);
  assert.equal(parseUiDocument({ ...EVENT, height: 'tall' }), null);
});

test('the height hint is clamped to 80–2000', () => {
  assert.equal(parseUiDocument({ ...EVENT, height: 10 })?.height, 80);
  assert.equal(parseUiDocument({ ...EVENT, height: 9000 })?.height, 2000);
  assert.equal(parseUiDocument({ ...EVENT, height: null })?.height, null);
});

test('a resolution settles a card once; a settled card never reopens', () => {
  const block = parseUiDocument({ ...EVENT, status: 'pending', expectsReply: true })!;
  const resolution = parseUiDocumentResolved({ id: ID, status: 'dismissed', resolvedAt: 5 })!;
  const settled = applyUiDocumentResolution(block, resolution);
  assert.equal(settled.status, 'dismissed');
  assert.equal(applyUiDocumentResolution(settled, { id: ID, status: 'answered', resolvedAt: 6 }).status, 'dismissed');
  assert.equal(parseUiDocumentResolved({ id: ID, status: 'pending' }), null);
});

test('the document is loaded from the Rooks origin, through the proxy', () => {
  assert.equal(uiDocumentUrl(ID), `/api/ui/ui-documents/${ID}/document`);
});

test('a purged document reads as expired, a failing daemon as unknown', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('{"error":"not_found"}', { status: 404 })) as typeof fetch;
    assert.deepEqual(await fetchUiDocument(ID), { kind: 'expired' });
    globalThis.fetch = (async () => new Response('', { status: 502 })) as typeof fetch;
    assert.deepEqual(await fetchUiDocument(ID), { kind: 'unknown' });
    globalThis.fetch = (async () => Response.json({ document: { ...EVENT, status: 'answered', resolvedAt: 9 } })) as typeof fetch;
    const found = await fetchUiDocument(ID);
    assert.equal(found.kind, 'found');
    assert.equal(found.kind === 'found' && found.document.status, 'answered');
  } finally {
    globalThis.fetch = realFetch;
  }
});
