import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  SETTINGS_GRAFT_SLOTS,
  SETTINGS_GROUP_TO_SLOT,
  settingsGroupForSlot,
  settingsSlotForGroup,
} from './plugin-host/settings-slots';

const SLOT_NAME = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/;

test('settingsSlotForGroup is a frozen table, not a slugifier', () => {
  assert.equal(settingsSlotForGroup('Missions'), 'settings.missions');
  assert.equal(settingsSlotForGroup('LLM fallback'), 'settings.llmfallback');
  assert.notEqual(settingsSlotForGroup('LLM fallback'), 'settings.llm-fallback');
  assert.equal(settingsSlotForGroup('Memory — injection'), 'settings.memoryinjection');
  assert.equal(settingsSlotForGroup('Global digest'), 'settings.digest');
  assert.equal(settingsSlotForGroup('Push'), 'settings.notifications');
});

test('settingsGroupForSlot is the inverse', () => {
  assert.equal(settingsGroupForSlot('settings.missions'), 'Missions');
  assert.equal(settingsGroupForSlot('settings.llmfallback'), 'LLM fallback');
  assert.equal(settingsGroupForSlot('settings.notifications'), 'Push');
  for (const [group, slot] of Object.entries(SETTINGS_GROUP_TO_SLOT)) {
    assert.equal(settingsGroupForSlot(slot), group);
    assert.equal(settingsSlotForGroup(group), slot);
  }
});

test('every graft slot is a legal slot name and a list', () => {
  const slots = Object.values(SETTINGS_GROUP_TO_SLOT);
  assert.equal(slots.length, Object.keys(SETTINGS_GRAFT_SLOTS).length);
  for (const slot of slots) {
    assert.match(slot, SLOT_NAME, slot);
    assert.doesNotMatch(slot, /[-/]/, slot);
    assert.equal(SETTINGS_GRAFT_SLOTS[slot], 'list');
  }
});

test('an unknown group is refused rather than slugified', () => {
  assert.throws(() => settingsSlotForGroup('LLM fallback'.toLowerCase()), /do not slugify/);
  assert.throws(() => settingsSlotForGroup('Not a group'), /do not slugify/);
  assert.throws(() => settingsGroupForSlot('settings.section'), /Unknown settings graft slot/);
  assert.throws(() => settingsGroupForSlot('settings.llm-fallback'), /Unknown settings graft slot/);
});

test('every group declared in the orchestrator SETTINGS has a graft slot', () => {
  const source = join(process.cwd(), '..', 'orchestrator', 'src', 'settings.ts');
  if (!existsSync(source)) return; // app package built alone (Docker context)
  const groups = new Set(
    [...readFileSync(source, 'utf8').matchAll(/\bgroup: '([^']+)'/g)].map((m) => m[1] ?? ''),
  );
  assert.ok(groups.size > 10, 'group scan found too few groups');
  for (const group of groups) {
    assert.ok(SETTINGS_GROUP_TO_SLOT[group], `settings group ${group} has no slot: Settings would hide it`);
  }
});
