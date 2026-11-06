import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

// TIM-0081: a tester saw renderers outlive their windows for days, each one
// holding an event stream open on the daemon, and suspected the tray's
// close-to-hide. The shell never hides: closing the window destroys it, and
// with it its renderer. These guards keep it that way — a hidden window keeps
// its page, its timers and its EventSources alive for as long as the shell runs.
// Multi-window V4 keeps hidden pages on purpose, within bounds: three per
// window (`view-pool.ts`), and every one closed with its window.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

test('the UI window is never hidden, only destroyed', () => {
  assert.doesNotMatch(source, /\.hide\(\)/, 'a hidden window keeps its renderer and its streams');
  assert.doesNotMatch(source, /\.minimize\(\)/);
});

test('closing the window is only deferred while its pages close, then it closes for real', () => {
  const start = source.indexOf("w.on('close', (event) => {");
  assert.ok(start > 0, 'the window registers a close handler');
  const handler = source.slice(start, source.indexOf("w.on('closed'", start));
  // The one preventDefault hands over to closePages, which ends on the window's own close.
  assert.match(handler, /event\.preventDefault\(\);\s*void closePages\(record\);\s*return;/);
  assert.equal(handler.match(/preventDefault/g)?.length, 1);
  const closePages = source.slice(source.indexOf('async function closePages('), source.indexOf('function createWindow('));
  assert.match(closePages, /record\.window\.close\(\);/);
  // Only a page the user keeps (unsaved changes) stops it: that is the browser's own rule.
  assert.match(closePages, /if \(kept\) \{/);
});

test('V4: a window that goes takes every page with it', () => {
  const closed = source.slice(source.indexOf("w.on('closed', () => {"), source.indexOf('enterMachine(record, opening.machineId'));
  assert.match(closed, /for \(const page of record\.pages\.everyPage\(\)\) if \(!contentsOf\(page\)\.isDestroyed\(\)\) contentsOf\(page\)\.close\(\);/);
});

test('once a window is closed the shell forgets it, so the tray reopens a fresh one', () => {
  const closed = source.slice(source.indexOf("w.on('closed', () => {"), source.indexOf('enterMachine(record, opening.machineId'));
  assert.match(closed, /windows\.remove\(id\);/);
  // showWindow only reuses windows that still exist.
  assert.match(source, /function liveWindows\(\): AppWindow\[\] \{\s*return windows\.list\(\)\.filter\(\(record\) => !record\.window\.isDestroyed\(\)\);/);
  assert.match(source, /const open = liveWindows\(\);\s*if \(open\.length > 0\) \{/);
});
