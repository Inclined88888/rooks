/**
 * Workflows plugs into the native triggers without depending on them: it
 * activates on `http` + `db` alone (a Free licence minted before
 * `@rooks/triggers` withholds that module), and offers its `workflow` action
 * exactly while the `triggers` service exists.
 */
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { createHttpPlugin } = await import('../../kernel/http-service.js');
const workflows = await import('./index.js');
const triggers = await import('../triggers/index.js');
const { actionProvider } = await import('../../triggers/actions.js');

const FIBER_ACTIVE = 2;

test('@rooks/workflows activates without triggers, and registers its action while they run', async () => {
  const root = new Context();
  await root.plugin(createHttpPlugin(express()));
  await root.plugin({ name: 'stub-db', apply(ctx: Context) { ctx.provide('db', {}); } });
  const fiber = await root.plugin(workflows);
  assert.equal(fiber.state, FIBER_ACTIVE);
  assert.equal(actionProvider('workflow'), null);

  const kanban = await root.plugin({ name: 'stub-kanban', apply(ctx: Context) { ctx.provide('kanban', {}); } });
  const triggersFiber = await root.plugin(triggers);
  assert.equal(triggersFiber.state, FIBER_ACTIVE);
  // The sub-fiber reacts on the next ticks.
  for (let i = 0; i < 20 && !actionProvider('workflow'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.notEqual(actionProvider('workflow'), null);

  // Triggers switched off (licence, settings): the action goes, Workflows stays.
  await kanban.dispose();
  for (let i = 0; i < 20 && actionProvider('workflow'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(actionProvider('workflow'), null);
  assert.equal(fiber.state, FIBER_ACTIVE);
  await root.fiber.dispose();
});
