import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWindowSchemeReport, recordMachineScheme, windowScheme } from './appearance.js';

test('without an install, windows open dark, whatever the OS', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-appearance-'));
  assert.equal(windowScheme(home), 'dark');
});

test('#132: an install keeps its own scheme, whatever the OS says', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-appearance-'));
  writeFileSync(join(home, 'appearance.json'), JSON.stringify({ scheme: 'light' }));
  assert.equal(windowScheme(home), 'light');
  writeFileSync(join(home, 'appearance.json'), '{broken');
  assert.equal(windowScheme(home), 'dark', 'an unreadable file is no install: dark');
  writeFileSync(join(home, 'appearance.json'), JSON.stringify({ scheme: 'dark' }));
  assert.equal(windowScheme(home), 'dark');
});

test('multi-window: a remote machine paints the mode its page last reported, this computer keeps the install\'s', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-appearance-'));
  writeFileSync(join(home, 'appearance.json'), JSON.stringify({ scheme: 'dark' }));
  // Never shown yet: this computer's mode stands in.
  assert.equal(windowScheme(home, 'vps'), 'dark');
  assert.equal(recordMachineScheme(home, 'vps', 'light'), true);
  assert.equal(recordMachineScheme(home, 'vps', 'light'), false, 'no change, no write');
  assert.equal(windowScheme(home, 'vps'), 'light');
  assert.equal(windowScheme(home, 'nas'), 'dark', 'another machine is not touched');
  assert.equal(windowScheme(home, null), 'dark', 'a window that follows the cookie reads the install');
  assert.equal(windowScheme(home, 'local'), 'dark');
  // This computer's mode is the daemon's file, never this cache.
  assert.equal(recordMachineScheme(home, 'local', 'light'), false);
  assert.equal(recordMachineScheme(home, null, 'light'), false);
  assert.equal(windowScheme(home, 'local'), 'dark');
});

test('multi-window: the cache keeps machine ids and modes only, and stays bounded', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-appearance-'));
  assert.equal(recordMachineScheme(home, '../appearance', 'light'), false);
  assert.equal(recordMachineScheme(home, 'vps', 'sepia' as 'light'), false);
  writeFileSync(join(home, 'machine-schemes.json'), JSON.stringify({ vps: 'light', 'a b': 'light', nas: 'blue' }));
  assert.equal(windowScheme(home, 'vps'), 'light');
  assert.equal(windowScheme(home, 'nas'), 'dark', 'a bad value is ignored: dark without an install');
  writeFileSync(join(home, 'machine-schemes.json'), '{broken');
  assert.equal(windowScheme(home, 'vps'), 'dark', 'an unreadable cache is no cache: dark without an install');
  for (let i = 0; i < 64; i += 1) assert.equal(recordMachineScheme(home, `m${i}`, 'light'), true);
  assert.equal(recordMachineScheme(home, 'one-more', 'light'), false);
  assert.equal(recordMachineScheme(home, 'm3', 'dark'), true, 'a known machine still changes');
});

test('multi-window: a page\'s report is a mode and, at most, a machine id', () => {
  assert.deepEqual(parseWindowSchemeReport({ scheme: 'light', machineId: 'vps' }), { scheme: 'light', machineId: 'vps' });
  assert.deepEqual(parseWindowSchemeReport({ scheme: 'dark' }), { scheme: 'dark', machineId: null });
  for (const bad of [null, 'light', { scheme: 'sepia' }, { scheme: 'light', machineId: 'https://evil.example' }, { scheme: 'light', machineId: 7 }]) {
    assert.equal(parseWindowSchemeReport(bad), null, JSON.stringify(bad));
  }
});
