/**
 * What acts on the backends at boot (the dispatcher's first pass) waits for the providers the product ships as
 * plugins: a pass that found `codex` unknown would send its tasks to another backend without a word.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { expectProviders, providersLoaded, whenProvidersLoaded } = await import('./registry.js');

const settled = async (promise: Promise<void>): Promise<boolean> => {
  let done = false;
  void promise.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

test('outside the daemon\'s boot nothing is expected, so nothing waits', async () => {
  assert.equal(await settled(whenProvidersLoaded()), true);
});

test('during boot the wait lasts until the plugin loader has run, and calling it twice changes nothing', async () => {
  expectProviders();
  expectProviders();
  const waiting = whenProvidersLoaded();
  assert.equal(await settled(waiting), false, 'the loader has not run');
  providersLoaded();
  assert.equal(await settled(waiting), true);
  assert.equal(await settled(whenProvidersLoaded()), true, 'and stays open afterwards');
  providersLoaded();
});
