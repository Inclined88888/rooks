/**
 * The real module activates on the services its catalogue entry promises —
 * and only on those. A fiber left PENDING is a daemon that refuses to start
 * on every tester's machine (`auditActivation`), which no route test sees.
 */
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { createHttpPlugin } = await import('../../kernel/http-service.js');
const triggers = await import('./index.js');

const FIBER_ACTIVE = 2;

test('@timon/triggers activates on http + db + kanban and provides `triggers`', async () => {
  const root = new Context();
  await root.plugin(createHttpPlugin(express()));
  await root.plugin({
    name: 'stub-services',
    apply(ctx: Context) {
      ctx.provide('db', {});
      ctx.provide('kanban', {});
    },
  });
  const fiber = await root.plugin(triggers);
  assert.equal(fiber.state, FIBER_ACTIVE);
  let seen: unknown;
  await root.plugin({ name: 'consumer', inject: ['triggers'], apply(ctx: Context) { seen = ctx.triggers; } });
  assert.equal(typeof (seen as { fire?: unknown }).fire, 'function');
  await root.fiber.dispose();
});

test('without kanban the module stays PENDING — hence its dependsOn', async () => {
  const root = new Context();
  await root.plugin(createHttpPlugin(express()));
  await root.plugin({ name: 'stub-db', apply(ctx: Context) { ctx.provide('db', {}); } });
  const fiber = await root.plugin(triggers);
  assert.notEqual(fiber.state, FIBER_ACTIVE);
  await root.fiber.dispose();
});
