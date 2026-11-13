import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

// The components of this tree rely on the automatic JSX runtime; the test runner compiles classic.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function setup() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="a"></div><div id="b"></div><div id="panel"></div>', { url: 'http://localhost/' });
  const globals = globalThis as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const lib = await import('./pending-attachments');
  lib.resetPendingAttachmentsForTests();
  const { draftKey } = await import('./composer-draft');
  return { dom, lib, draftKey, store: dom.window.localStorage };
}

test('a deposit lands in its own box only, and removal takes it back', async () => {
  const { lib, draftKey } = await setup();
  const alice = draftKey('alice', 'm1');
  const bob = draftKey('bob', 'm2');
  const r = lib.depositAttachment(alice, { kind: 'text', label: 'Note', text: 'hello' });
  assert.equal(r.ok, true);
  assert.equal(lib.listPendingAttachments(alice).length, 1);
  assert.equal(lib.listPendingAttachments(bob).length, 0);
  assert.equal(lib.listPendingAttachments(draftKey('alice')).length, 0, 'the same agent on another thread is another box');
  if (!r.ok) return;
  lib.removePendingAttachments(alice, [r.id]);
  assert.equal(lib.listPendingAttachments(alice).length, 0);
});

test('a deposit the composer could not send is refused', async () => {
  const { lib } = await setup();
  const box = 'k';
  const refused = (deposit: Parameters<typeof lib.depositAttachment>[1]) => {
    const r = lib.depositAttachment(box, deposit);
    return r.ok ? null : r.reason;
  };
  assert.equal(refused({ kind: 'image', label: 'x', mediaType: 'image/svg+xml', base64: PNG }), 'invalid');
  assert.equal(refused({ kind: 'image', label: 'x', mediaType: 'image/png', base64: 'not base64!' }), 'invalid');
  assert.equal(refused({ kind: 'text', label: '  ', text: 'body' }), 'invalid');
  assert.equal(refused({ kind: 'text', label: 'x', text: '   ' }), 'invalid');
  assert.equal(refused({ kind: 'text', label: 'x', text: 'a'.repeat(lib.MAX_TEXT_ATTACHMENT_CHARS + 1) }), 'too-large');
  assert.equal(lib.listPendingAttachments(box).length, 0);
  for (let i = 0; i < lib.MAX_BOX_ITEMS; i += 1) {
    assert.equal(lib.depositAttachment(box, { kind: 'text', label: `n${i}`, text: 'x' }).ok, true);
  }
  assert.equal(refused({ kind: 'text', label: 'one more', text: 'x' }), 'box-full');
});

test('the box survives a reload, per machine, and drops what it cannot read', async () => {
  const { lib, store, dom } = await setup();
  lib.depositAttachment('k', { kind: 'image', label: 'Shot', mediaType: 'image/png', base64: PNG });
  lib.resetPendingAttachmentsForTests();
  const [item] = lib.listPendingAttachments('k');
  assert.equal(item?.kind, 'image');
  assert.equal(item?.label, 'Shot');

  store.setItem('rooks.pending-attachments.v1:bad', JSON.stringify([
    { id: '1', label: 'svg', createdAt: 1, size: 3, kind: 'image', mediaType: 'image/svg+xml', base64: 'AAA=' },
    { id: '2', label: 'ok', createdAt: 1, size: 2, kind: 'text', text: 'hi' },
    'garbage',
  ]));
  assert.deepEqual(lib.listPendingAttachments('bad').map((i) => i.id), ['2']);

  // Another machine's page reads its own box, never local's.
  dom.window.document.documentElement.setAttribute('data-rooks-machine', 'nas-1');
  lib.resetPendingAttachmentsForTests();
  assert.equal(lib.listPendingAttachments('k').length, 0);
});

test('a deposit made in another window reaches this one', async () => {
  const { lib, store, dom } = await setup();
  let calls = 0;
  const off = lib.subscribePendingAttachments('k', () => { calls += 1; });
  const value = JSON.stringify([{ id: 'w2', label: 'from elsewhere', createdAt: 1, size: 2, kind: 'text', text: 'hi' }]);
  store.setItem('rooks.pending-attachments.v1:k', value);
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: 'rooks.pending-attachments.v1:k', newValue: value }));
  assert.equal(calls, 1);
  assert.deepEqual(lib.listPendingAttachments('k').map((i) => i.id), ['w2']);
  off();
});

test('a turn takes the images aside and appends the text after the typed words', async () => {
  const { lib } = await setup();
  lib.depositAttachment('k', { kind: 'text', label: 'A', text: 'first block\n' });
  lib.depositAttachment('k', { kind: 'image', label: 'Shot', mediaType: 'image/png', base64: PNG });
  lib.depositAttachment('k', { kind: 'text', label: 'B', text: 'second block' });
  const turn = lib.attachmentsForTurn('fix this', lib.listPendingAttachments('k'));
  assert.equal(turn.text, 'fix this\n\nfirst block\n\nsecond block');
  assert.equal(turn.images.length, 1);
  assert.equal(turn.textBytes, 'first block\n'.length + 'second block'.length);
  assert.equal(lib.attachmentsForTurn('', lib.listPendingAttachments('k')).text, 'first block\n\nsecond block');
  assert.equal(lib.attachmentsForTurn('only words', []).text, 'only words');
});

test('a deposit from another React tree shows in the right composer, and its removal too', async () => {
  const { lib, draftKey, dom } = await setup();
  const { createRoot } = await import('react-dom/client');
  const { PendingAttachmentRow } = await import('../components/chat/pending-attachment-row');
  const alice = draftKey('alice', 'm1');
  const bob = draftKey('bob', 'm2');

  function Chat({ box }: { box: string }) {
    const items = lib.usePendingAttachments(box);
    return React.createElement(PendingAttachmentRow, { box, items });
  }
  function Panel({ target }: { target: string }) {
    return React.createElement('button', {
      id: 'deposit',
      onClick: () => lib.depositAttachment(target, { kind: 'image', label: 'Annotated', mediaType: 'image/png', base64: PNG }),
    }, 'send to chat');
  }

  const doc = dom.window.document;
  const roots = [
    createRoot(doc.getElementById('a')!),
    createRoot(doc.getElementById('b')!),
    createRoot(doc.getElementById('panel')!),
  ];
  try {
    await React.act(async () => {
      roots[0]!.render(React.createElement(Chat, { box: alice }));
      roots[1]!.render(React.createElement(Chat, { box: bob }));
      roots[2]!.render(React.createElement(Panel, { target: alice }));
    });
    assert.equal(doc.querySelectorAll('[data-pending-attachment]').length, 0);

    await React.act(async () => {
      doc.getElementById('deposit')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    const inA = doc.querySelectorAll('#a [data-pending-attachment]');
    assert.equal(inA.length, 1, 'the deposit shows in its conversation');
    assert.equal(doc.querySelectorAll('#b [data-pending-attachment]').length, 0, 'and in no other chat');
    assert.match(doc.querySelector('#a img')!.getAttribute('src') ?? '', /^data:image\/png;base64,/);

    await React.act(async () => {
      doc.querySelector('#a [data-pending-attachment] button')!
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(doc.querySelectorAll('#a [data-pending-attachment]').length, 0);
    assert.equal(lib.listPendingAttachments(alice).length, 0);
  } finally {
    await React.act(async () => { for (const root of roots) root.unmount(); });
  }
});
