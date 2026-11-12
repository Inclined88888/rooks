/**
 * TIM-0082 — the orchestrator prompt must not present Claude as "the" default
 * backend: a GPT pilot that creates an agent without saying `--backend` read it
 * as an instruction, and told to reuse existing agents it still created a new
 * one. It must also point at `agent_list` before `agent_create`.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { defaultMainPrompt } = await import('./agent.js');

test('the backend section does not crown a default and asks to list agents first', () => {
  const prompt = defaultMainPrompt();
  const section = prompt.slice(prompt.indexOf('## Backend selection'), prompt.indexOf('# Creating / updating agents'));
  assert.ok(section.length > 0, 'the section exists');
  assert.doesNotMatch(section, /\(default\)/);
  assert.match(section, /agent_list[\s\S]*agent_create/, 'agent_list is named before agent_create');
});
