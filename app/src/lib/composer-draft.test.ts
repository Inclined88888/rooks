import assert from 'node:assert/strict';
import test from 'node:test';

async function harness() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = globalThis as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useComposerDraft, draftKey } = await import('./composer-draft');

  let current: { text: string; set: (v: string, opts?: { store?: boolean }) => void } | null = null;
  function Probe({ id, mission }: { id: string; mission?: string }) {
    const [text, set] = useComposerDraft(draftKey(id, mission));
    current = { text, set };
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  const mount = (id: string, mission?: string) => React.act(async () => { root.render(React.createElement(Probe, { id, mission })); });
  const unmount = () => React.act(async () => { root.render(null); });
  const type = (v: string) => React.act(async () => { current!.set(v); });
  const show = (v: string) => React.act(async () => { current!.set(v, { store: false }); });
  return { mount, unmount, type, show, text: () => current!.text, store: dom.window.localStorage, root, React };
}

test('a typed draft survives unmount and remount, and sending empties it', async () => {
  const h = await harness();
  try {
    await h.mount('alice');
    await h.type('half-written thought');
    await h.unmount();
    await h.mount('alice');
    assert.equal(h.text(), 'half-written thought');

    await h.type('');
    assert.equal(h.store.length, 0, 'an emptied draft leaves nothing in storage');
    await h.unmount();
    await h.mount('alice');
    assert.equal(h.text(), '');
  } finally {
    await h.React.act(async () => { h.root.unmount(); });
  }
});

test('drafts are kept per conversation', async () => {
  const h = await harness();
  try {
    await h.mount('alice');
    await h.type('for alice');
    await h.mount('bob');
    assert.equal(h.text(), '', 'another agent starts from its own draft');
    await h.type('for bob');
    await h.mount('alice');
    assert.equal(h.text(), 'for alice');
    await h.mount('bob');
    assert.equal(h.text(), 'for bob');
  } finally {
    await h.React.act(async () => { h.root.unmount(); });
  }
});

test('two missions of the same agent keep separate drafts', async () => {
  const h = await harness();
  try {
    await h.mount('alice', 'm1');
    await h.type('first thread');
    await h.mount('alice', 'm2');
    assert.equal(h.text(), '', 'another mission of the same agent starts empty');
    await h.type('second thread');
    await h.mount('alice');
    assert.equal(h.text(), '', 'a not-yet-started conversation has its own draft');
    await h.mount('alice', 'm1');
    assert.equal(h.text(), 'first thread');
    await h.unmount();
    await h.mount('alice', 'm2');
    assert.equal(h.text(), 'second thread');
    await h.type('');
    await h.mount('alice', 'm1');
    assert.equal(h.text(), 'first thread', 'sending in one mission leaves the other draft alone');
  } finally {
    await h.React.act(async () => { h.root.unmount(); });
  }
});

test('a recalled prompt is shown without replacing the stored draft', async () => {
  const h = await harness();
  try {
    await h.mount('alice');
    await h.type('what I was writing');
    await h.show('an older prompt, recalled with the up arrow');
    assert.equal(h.text(), 'an older prompt, recalled with the up arrow');
    await h.unmount();
    await h.mount('alice');
    assert.equal(h.text(), 'what I was writing', 'leaving on a recalled entry keeps the draft');
    await h.show('recalled again');
    await h.type('recalled again, then edited');
    await h.unmount();
    await h.mount('alice');
    assert.equal(h.text(), 'recalled again, then edited', 'an edited entry is the draft');
  } finally {
    await h.React.act(async () => { h.root.unmount(); });
  }
});

test('the composer shows a recalled prompt without storing it', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = readFileSync(join(process.cwd(), 'src', 'components', 'chat', 'composer.tsx'), 'utf8');
  const recall = src.slice(src.indexOf('promptHistory.step('), src.indexOf('setSlashDismissed(true)', src.indexOf('promptHistory.step(')));
  assert.match(recall, /setInput\(text, \{ store: false \}\)/);
});
