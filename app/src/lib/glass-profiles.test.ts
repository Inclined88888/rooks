import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_GLASS_PROFILES, editGlassProfiles, glassSettingsOf, readGlassProfiles, sameGlassSettings, writeGlassProfiles,
} from './glass-profiles';
import { DEFAULT_APPEARANCE } from '../plugins-client/ui-theme-variants';

const frosted = glassSettingsOf({ ...DEFAULT_APPEARANCE, glass: true, glassScope: 'widgets', glassBlur: 24, glassZones: { chrome: { blur: 4, transparency: 80, tint: '#112233' } }, glassFloor: 50 });

test('a profile holds the glass fields only, and reads back the same', () => {
  assert.deepEqual(Object.keys(frosted).sort(), ['glass', 'glassBlur', 'glassBubbles', 'glassFloor', 'glassScope', 'glassTint', 'glassTransparency', 'glassZones']);
  const row = writeGlassProfiles([{ id: 'a', name: 'Frosted', settings: frosted }]);
  const [back] = readGlassProfiles(JSON.parse(JSON.stringify(row)));
  assert.ok(back && sameGlassSettings(back.settings, frosted));
});

test('a stored list is read without trust', () => {
  for (const raw of [null, 42, [], { profiles: 'x' }]) assert.deepEqual(readGlassProfiles(raw), []);
  const list = readGlassProfiles({ profiles: [
    { id: 'a', name: '  Night   mode ', settings: { glassBlur: 999, glassScope: 'nope', glassZones: { islands: { blur: 2 } } } },
    { id: 'a', name: 'duplicate id', settings: {} },
    { id: '', name: 'no id', settings: {} },
    { id: 'b', name: '   ', settings: {} },
    { id: 'c', name: 'Old build', settings: 'garbage' },
  ] });
  assert.deepEqual(list.map((p) => p.id), ['a', 'c']);
  assert.equal(list[0]!.name, 'Night mode');
  assert.equal(list[0]!.settings.glassBlur, 40, 'clamped');
  assert.equal(list[0]!.settings.glassScope, 'island', 'unknown scope falls back');
  assert.deepEqual(list[0]!.settings.glassZones.islands, { blur: 2, transparency: 40, tint: null });
  assert.ok(sameGlassSettings(list[1]!.settings, glassSettingsOf(DEFAULT_APPEARANCE)), 'garbage settings read as the defaults');
  const many = { profiles: Array.from({ length: MAX_GLASS_PROFILES + 5 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, settings: {} })) };
  assert.equal(readGlassProfiles(many).length, MAX_GLASS_PROFILES);
});

test('the same look compares equal whatever the order of its zones', () => {
  const a = { ...frosted, glassZones: { chrome: { blur: 1, transparency: 2, tint: null }, widgets: { blur: 3, transparency: 4, tint: null } } };
  const b = { ...frosted, glassZones: { widgets: { blur: 3, transparency: 4, tint: null }, chrome: { blur: 1, transparency: 2, tint: null } } };
  assert.ok(sameGlassSettings(a, b));
  assert.ok(!sameGlassSettings(a, { ...b, glassFloor: 10 }));
});

test('edits add, rename, overwrite and remove, and refuse what would change nothing', () => {
  const base = glassSettingsOf(DEFAULT_APPEARANCE);
  const one = editGlassProfiles([], { kind: 'add', id: 'a', name: ' Minimal ', settings: base })!;
  assert.deepEqual(one.map((p) => p.name), ['Minimal']);
  assert.equal(editGlassProfiles(one, { kind: 'add', id: 'b', name: '   ', settings: base }), null, 'empty name');
  assert.equal(editGlassProfiles(one, { kind: 'rename', id: 'zz', name: 'X' }), null, 'unknown id');
  assert.equal(editGlassProfiles(one, { kind: 'rename', id: 'a', name: 'Clear' })![0]!.name, 'Clear');
  assert.ok(sameGlassSettings(editGlassProfiles(one, { kind: 'overwrite', id: 'a', settings: frosted })![0]!.settings, frosted));
  assert.deepEqual(editGlassProfiles(one, { kind: 'remove', id: 'a' }), []);
  const full = Array.from({ length: MAX_GLASS_PROFILES }, (_, i) => ({ id: `p${i}`, name: `P${i}`, settings: base }));
  assert.equal(editGlassProfiles(full, { kind: 'add', id: 'x', name: 'One more', settings: base }), null, 'full list');
});
