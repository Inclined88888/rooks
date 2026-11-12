import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_APPEARANCE_DEFAULTS,
  COMPOSER_TOGGLES,
  readAppearance,
  setToolCallsMode,
  setWorkingEnterMode,
  toggleAppearance,
  workingSendMode,
} from '@/components/chat/chat-appearance';

test('an unset or corrupt appearance paints the skin the product ships with', () => {
  for (const raw of [undefined, null, 42, [], {}, { toolCalls: 'removed' }, { flatBubbles: 'yes' }]) {
    assert.deepEqual(readAppearance(raw), CHAT_APPEARANCE_DEFAULTS);
  }
  // Pinned values, not a rewording of the module: the shipped skin is a
  // product decision, and moving one of these silently changes the first
  // screen of every install.
  assert.equal(CHAT_APPEARANCE_DEFAULTS.flatBubbles, true);
  assert.equal(CHAT_APPEARANCE_DEFAULTS.toolCalls, 'stacked');
  assert.equal(CHAT_APPEARANCE_DEFAULTS.showUsage, false);
  assert.equal(CHAT_APPEARANCE_DEFAULTS.showInputBorder, true);
  // The composer's own controls all stay: what a thread says about its model,
  // its effort, its branch and its context is not decoration.
  for (const key of COMPOSER_TOGGLES.filter((k) => k !== 'showUsage')) {
    assert.equal(CHAT_APPEARANCE_DEFAULTS[key], true);
  }
});

test('an explicit choice survives the read, field by field', () => {
  const stored = {
    flatBubbles: true,
    toolCalls: 'stacked',
    showUsage: false,
    showModel: false,
    showEffort: false,
    showPermission: false,
    showBranch: false,
    showContext: false,
    showInputBorder: false,
    focusMode: true,
    enterWhileWorking: 'queue',
  };
  assert.deepEqual(readAppearance(stored), stored);
  // A key we don't know is ignored rather than carried into the state.
  assert.deepEqual(readAppearance({ ...stored, ghost: 1 }), stored);
});

test('focus mode is a layer over the collapse, not a write into it', () => {
  // The model carries the intent and NOTHING about the columns: what is
  // folded by hand lives in `chat-columns`, and leaving focus must give back
  // exactly the screen that entered it.
  assert.equal(CHAT_APPEARANCE_DEFAULTS.focusMode, false);
  const focused = toggleAppearance(CHAT_APPEARANCE_DEFAULTS, 'focusMode');
  assert.equal(focused.focusMode, true);
  assert.deepEqual(toggleAppearance(focused, 'focusMode'), CHAT_APPEARANCE_DEFAULTS);
  assert.equal(readAppearance({ focusMode: true }).focusMode, true);
});

test('the tool-call mode is set, never toggled', () => {
  const stacked = setToolCallsMode(CHAT_APPEARANCE_DEFAULTS, 'stacked');
  assert.equal(stacked.toolCalls, 'stacked');
  assert.equal(setToolCallsMode(stacked, 'full').toolCalls, 'full');
  // Setting a mode leaves every other field alone.
  assert.equal(stacked.flatBubbles, CHAT_APPEARANCE_DEFAULTS.flatBubbles);
});

test('while the agent works, Enter steers by default and Ctrl/Cmd+Enter does the other', () => {
  assert.equal(CHAT_APPEARANCE_DEFAULTS.enterWhileWorking, 'steer');
  assert.equal(readAppearance({ enterWhileWorking: 'queue' }).enterWhileWorking, 'queue');
  assert.equal(readAppearance({ enterWhileWorking: 'later' }).enterWhileWorking, 'steer');
  assert.equal(setWorkingEnterMode(CHAT_APPEARANCE_DEFAULTS, 'queue').enterWhileWorking, 'queue');
  assert.equal(workingSendMode('steer', false), 'steer');
  assert.equal(workingSendMode('steer', true), 'queue');
  assert.equal(workingSendMode('queue', false), 'queue');
  assert.equal(workingSendMode('queue', true), 'steer');
});
