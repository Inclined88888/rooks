/** The agents module activates before the provider loader; seeding must wait for it. */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import { existsSync } from 'node:fs';
const { createHttpPlugin } = await import('./http-service.js');
const { expectProviders, providersLoaded } = await import('../backends/registry.js');
const { apply } = await import('../plugins-bundled/agents/index.js');
const { agentDir } = await import('../paths.js');
const { mountOfficialProviders, stubCliBinaries } = await import('../../tests/helpers/official-providers.js');
const { getAgent } = await import('../agent.js');

test('an empty home seeds its main agent only after official providers have loaded', async () => {
  expectProviders();
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(express()));
  try {
    apply(ctx);
    await Promise.resolve();
    assert.equal(existsSync(agentDir('_main')), false, 'no backend is available to seed yet');
    await stubCliBinaries('claude');
    await mountOfficialProviders();
    providersLoaded();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(getAgent('_main')?.backend, 'the main agent was created with an available backend');
  } finally { providersLoaded(); await ctx.fiber.dispose(); }
});

test('TODO #551: a provider still being restored after the loader holds whoever waits on the registry', async () => {
  const { providersPending, whenProvidersLoaded } = await import('../backends/registry.js');
  expectProviders();
  let release!: () => void;
  providersPending(new Promise<void>((resolve) => { release = resolve; }));
  let ready = false;
  const waiting = whenProvidersLoaded().then(() => { ready = true; });
  try {
    providersLoaded();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false, 'the loader ran, but an ACP agent is still being hashed');
    release();
    await waiting;
    assert.equal(ready, true);
    // A restore that fails is over too: nothing must wait on it for good.
    providersPending(Promise.reject(new Error('tampered')));
    await whenProvidersLoaded();
  } finally { release(); providersLoaded(); }
});
