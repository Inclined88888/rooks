import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROMPT_HISTORY_MAX,
  canRecallPrompt,
  pushPromptEntry,
} from './prompt-history';

async function harness() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = globalThis as Record<string, unknown>;
  globals.window = dom.window;
  globals.document = dom.window.document;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { usePromptHistory, promptHistoryKey, loadPromptHistory } = await import('./prompt-history');

  let current: ReturnType<typeof usePromptHistory> | null = null;
  function Probe({ id }: { id: string | null }) {
    current = usePromptHistory(id);
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  const mount = (id: string | null) => React.act(async () => { root.render(React.createElement(Probe, { id })); });
  const h = () => current!;
  const close = () => React.act(async () => { root.unmount(); });
  return { mount, h, close, store: dom.window.localStorage, promptHistoryKey, loadPromptHistory };
}

test('↑ walks back from the newest prompt, ↓ comes back to the draft', async () => {
  const t = await harness();
  try {
    await t.mount('alice');
    t.h().record('first');
    t.h().record('second');
    t.h().record('third');

    assert.equal(t.h().step('older', 'half-typed'), 'third');
    assert.equal(t.h().step('older', 'third'), 'second');
    assert.equal(t.h().step('older', 'second'), 'first');
    assert.equal(t.h().step('older', 'first'), null, 'nothing older: the key stays native');
    assert.equal(t.h().step('newer', 'first'), 'second');
    assert.equal(t.h().step('newer', 'second'), 'third');
    assert.equal(t.h().step('newer', 'third'), 'half-typed', 'the draft is never lost');
    assert.equal(t.h().step('newer', 'half-typed'), null, 'already on the draft');
  } finally {
    await t.close();
  }
});

test('an empty history leaves both keys to the browser', async () => {
  const t = await harness();
  try {
    await t.mount('alice');
    assert.equal(t.h().step('older', ''), null);
    assert.equal(t.h().step('newer', ''), null);
  } finally {
    await t.close();
  }
});

test('editing a recalled prompt makes it the new draft', async () => {
  const t = await harness();
  try {
    await t.mount('alice');
    t.h().record('one');
    t.h().record('two');
    assert.equal(t.h().step('older', 'draft'), 'two');
    assert.equal(t.h().step('older', 'two'), 'one');
    t.h().reset();
    assert.equal(t.h().step('older', 'one, edited'), 'two', 'browsing restarts from the newest');
    assert.equal(t.h().step('newer', 'two'), 'one, edited');
  } finally {
    await t.close();
  }
});

test('sending leaves the browsing and stores the prompt for the next ↑', async () => {
  const t = await harness();
  try {
    await t.mount('alice');
    t.h().record('one');
    assert.equal(t.h().step('older', ''), 'one');
    t.h().record('one again');
    assert.equal(t.h().step('newer', ''), null, 'back on the (empty) draft');
    assert.equal(t.h().step('older', ''), 'one again');
  } finally {
    await t.close();
  }
});

test('histories are kept per agent and survive a remount', async () => {
  const t = await harness();
  try {
    await t.mount('alice');
    t.h().record('for alice');
    await t.mount('bob');
    assert.equal(t.h().step('older', ''), null, 'another agent has its own history');
    t.h().record('for bob');
    await t.mount(null);
    assert.equal(t.h().step('older', ''), null, 'no conversation, no history');
    t.h().record('ignored');
    await t.mount('alice');
    assert.equal(t.h().step('older', ''), 'for alice');
    assert.deepEqual(t.loadPromptHistory(t.promptHistoryKey('bob')), ['for bob']);
    assert.equal(t.store.length, 2, 'only the two agents wrote anything');
  } finally {
    await t.close();
  }
});

test('a prompt sent from another cell of the same agent is seen at the next ↑', async () => {
  const t = await harness();
  try {
    await t.mount('alice');
    t.h().record('mine');
    // What a second multichat cell on the same agent writes.
    t.store.setItem(t.promptHistoryKey('alice'), JSON.stringify(['theirs', 'mine']));
    assert.equal(t.h().step('older', ''), 'theirs');
  } finally {
    await t.close();
  }
});

test('an unreadable stored value counts as an empty history', async () => {
  const t = await harness();
  try {
    t.store.setItem(t.promptHistoryKey('alice'), '{not json');
    await t.mount('alice');
    assert.equal(t.h().step('older', ''), null);
    t.h().record('fresh');
    assert.deepEqual(t.loadPromptHistory(t.promptHistoryKey('alice')), ['fresh']);
  } finally {
    await t.close();
  }
});

test('pushPromptEntry trims, skips blanks and a repeat of the last prompt', () => {
  assert.deepEqual(pushPromptEntry([], '  hello \n'), ['hello']);
  assert.deepEqual(pushPromptEntry(['hello'], '   '), ['hello']);
  assert.deepEqual(pushPromptEntry(['hello'], 'hello'), ['hello']);
  assert.deepEqual(pushPromptEntry(['hello', 'bye'], 'bye'), ['bye', 'hello', 'bye'], 'only the LAST one is folded');
});

test('the history is bounded, the oldest prompt goes first', () => {
  let list: string[] = [];
  for (let i = 0; i < PROMPT_HISTORY_MAX + 5; i++) list = pushPromptEntry(list, `p${i}`);
  assert.equal(list.length, PROMPT_HISTORY_MAX);
  assert.equal(list[0], `p${PROMPT_HISTORY_MAX + 4}`);
  assert.equal(list.at(-1), 'p5');
});

test('a single line recalls from anywhere, a multi-line text only from its edges', () => {
  assert.equal(canRecallPrompt('older', '', 0, 0), true, 'empty field');
  assert.equal(canRecallPrompt('older', 'one line', 4, 4), true);
  assert.equal(canRecallPrompt('newer', 'one line', 4, 4), true);

  const text = 'first line\nsecond line';
  assert.equal(canRecallPrompt('older', text, 0, 0), true, 'caret at the start');
  assert.equal(canRecallPrompt('older', text, 15, 15), false, 'middle of a multi-line text');
  assert.equal(canRecallPrompt('older', text, text.length, text.length), false);
  assert.equal(canRecallPrompt('newer', text, text.length, text.length), true, 'caret at the end');
  assert.equal(canRecallPrompt('newer', text, 0, 0), false);
});

test('a paragraph wrapped by the box is multi-line too', () => {
  const text = 'a long prompt that the box wraps over three lines';
  assert.equal(canRecallPrompt('older', text, 20, 20, true), false, 'caret in the middle of a wrapped text');
  assert.equal(canRecallPrompt('newer', text, 20, 20, true), false);
  assert.equal(canRecallPrompt('older', text, 0, 0, true), true, 'from its start');
  assert.equal(canRecallPrompt('newer', text, text.length, text.length, true), true, 'from its end');
});

test('a selection keeps the native arrow keys', () => {
  assert.equal(canRecallPrompt('older', 'one line', 0, 3), false);
  assert.equal(canRecallPrompt('newer', 'a\nb', 0, 3), false);
});
