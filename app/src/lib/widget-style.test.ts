import assert from 'node:assert/strict';
import test from 'node:test';

import { effectiveWidgetStyle } from '../components/widget-host/use-widget-style';

const site = (over: Partial<{ borderless: boolean; transparent: boolean; at: number }> = {}) => ({ borderless: false, transparent: false, at: 0, ...over });

test('before the site style was ever changed, every widget keeps its own choice', () => {
  const style = effectiveWidgetStyle({ borderless: true, transparent: undefined }, site());
  assert.equal(style.borderless, true);
  assert.equal(style.transparent, false);
  assert.equal(style.own, true);
});

test('changing the site style overrules the choices made before it, on every widget', () => {
  // Eleven widgets were borderless one by one; the site now says bordered, and says it later.
  const old = { borderless: true, borderlessAt: 1000 };
  const legacy = { borderless: true }; // no date: older than any change
  assert.equal(effectiveWidgetStyle(old, site({ borderless: false, at: 2000 })).borderless, false);
  assert.equal(effectiveWidgetStyle(legacy, site({ borderless: false, at: 2000 })).borderless, false);
  assert.equal(effectiveWidgetStyle(legacy, site({ borderless: false, at: 2000 })).own, false);
  // And the other way round.
  assert.equal(effectiveWidgetStyle({ borderless: false }, site({ borderless: true, at: 2000 })).borderless, true);
});

test('a choice made after the site style change wins over it', () => {
  const style = effectiveWidgetStyle({ borderless: false, borderlessAt: 3000 }, site({ borderless: true, at: 2000 }));
  assert.equal(style.borderless, false);
  assert.equal(style.own, true);
});

test('the two fields are dated apart', () => {
  const style = effectiveWidgetStyle({ borderless: true, borderlessAt: 3000, transparent: true, transparentAt: 1000 }, site({ borderless: false, transparent: false, at: 2000 }));
  assert.equal(style.borderless, true, 'the newer choice stands');
  assert.equal(style.transparent, false, 'the older one gave way');
});
