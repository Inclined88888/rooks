import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUSH_TO_TALK_DEFAUT,
  estDeclencheurPushToTalk,
  libelleTouche,
  lirePushToTalk,
  serialiserPushToTalk,
  toucheAutorisee,
} from './push-to-talk';

test('les touches qui écrivent ou pilotent la page sont refusées', () => {
  for (const code of ['KeyA', 'Digit1', 'Space', 'Enter', 'Tab', 'Backspace', 'Escape', 'Numpad1', 'Comma', '']) {
    assert.equal(toucheAutorisee(code), false, code);
  }
});

test('les touches libres sont acceptables comme binding', () => {
  for (const code of ['Insert', 'F8', 'ShiftRight', 'ControlLeft', 'ScrollLock', 'Pause', 'Home']) {
    assert.equal(toucheAutorisee(code), true, code);
  }
});

test('le libellé sépare les mots collés du code', () => {
  assert.equal(libelleTouche('Insert'), 'Insert');
  assert.equal(libelleTouche('ShiftLeft'), 'Shift Left');
  assert.equal(libelleTouche(''), '');
});

test('une préférence absente ou illisible retombe sur le défaut', () => {
  assert.deepEqual(lirePushToTalk(null), PUSH_TO_TALK_DEFAUT);
  assert.deepEqual(lirePushToTalk('{'), PUSH_TO_TALK_DEFAUT);
  assert.deepEqual(lirePushToTalk('"insert"'), PUSH_TO_TALK_DEFAUT);
});

test('une touche stockée devenue interdite retombe sur le défaut', () => {
  assert.deepEqual(
    lirePushToTalk(JSON.stringify({ actif: true, code: 'KeyA' })),
    { actif: true, code: 'Insert' },
  );
});

test('aller-retour de sérialisation', () => {
  const prefs = { actif: true, code: 'F8' };
  assert.deepEqual(lirePushToTalk(serialiserPushToTalk(prefs)), prefs);
});

test('le déclencheur ne réagit qu’à la touche liée, réglage actif', () => {
  const prefs = { actif: true, code: 'Insert' };
  assert.equal(estDeclencheurPushToTalk({ code: 'Insert' }, prefs), true);
  assert.equal(estDeclencheurPushToTalk({ code: 'F8' }, prefs), false);
  assert.equal(estDeclencheurPushToTalk({ code: 'Insert' }, { ...prefs, actif: false }), false);
});

test('l’auto-repeat du clavier ne rouvre pas la dictée', () => {
  assert.equal(
    estDeclencheurPushToTalk({ code: 'Insert', repeat: true }, { actif: true, code: 'Insert' }),
    false,
  );
});
