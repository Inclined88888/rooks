import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { reopenHint } from './reopen-hint.js';

test('the tray is only named when it exists', () => {
  assert.equal(reopenHint('en', true, 'Rooks', 'moment'), 'reopen the window from the Rooks icon in the notification area in a moment');
  assert.equal(reopenHint('en', false, 'Rooks', 'minute'), 'quit Rooks and launch it again in a minute');
  assert.equal(reopenHint('en', false, 'Rooks'), 'quit Rooks and launch it again');
});

test('the hint speaks the dialog\'s language', () => {
  assert.equal(reopenHint('fr', true, 'Rooks', 'moment'), 'rouvrez la fenêtre depuis l’icône Rooks de la zone de notification dans un instant');
  assert.equal(reopenHint('fr-CA', false, 'Rooks'), 'quittez Rooks puis relancez-le');
});

test('no startup message promises a tray that may be missing', () => {
  const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
  assert.doesNotMatch(main, /from the tray/);
  assert.equal(main.match(/reopenHint\(locale, tray !== null/g)?.length, 3);
});
