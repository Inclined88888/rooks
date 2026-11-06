import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpr } from './expr.js';
import { contextValue, interpolateTemplate } from './template.js';

// Ids as the builder's `newNodeId` writes them.
const context = {
  input: { text: 'hi' },
  nodes: {
    'agent-1': { status: 'ok', output: { text: 'drafted', tags: ['a', 'b'] }, taken_port: 'done' },
    'not-1': { status: 'ok', output: { ready: true } },
    'true-x': { status: 'failed', output: null },
    'or-2': { status: 'ok', output: { n: 3 } },
  },
};

test('a template reads a node whose id carries a dash', () => {
  assert.equal(interpolateTemplate('{{nodes.agent-1.output.text}}', context), 'drafted');
  assert.equal(interpolateTemplate('[{{ nodes.agent-1.output.tags }}]', context), '[["a","b"]]');
  assert.equal(interpolateTemplate('{{nodes.agent-1.taken_port}} / {{input.text}}', context), 'done / hi');
  assert.equal(contextValue(context, 'nodes.agent-1.output.text'), 'drafted');
});

test('a template still leaves what is not a path untouched and blanks an unknown one', () => {
  assert.equal(interpolateTemplate('{{nodes.agent-9.output.text}}', context), '');
  assert.equal(interpolateTemplate('{{-1}} {{ 1abc }}', context), '{{-1}} {{ 1abc }}');
});

test('a condition reads a node whose id carries a dash', () => {
  assert.equal(evaluateExpr("nodes.agent-1.status == 'ok'", context), true);
  assert.equal(evaluateExpr("nodes.agent-1.output.text contains 'draft'", context), true);
  assert.equal(evaluateExpr('exists nodes.agent-1.output', context), true);
  assert.equal(evaluateExpr('not exists nodes.agent-2.output', context), true);
  assert.equal(evaluateExpr("nodes.agent-1.taken_port=='done'", context), true);
});

test('an identifier that starts with a keyword stays an identifier', () => {
  assert.equal(evaluateExpr('nodes.not-1.output.ready', context), true);
  assert.equal(evaluateExpr("nodes.true-x.status == 'failed'", context), true);
  assert.equal(evaluateExpr('nodes.or-2.output.n > 2 and not nodes.true-x.output', context), true);
  assert.equal(evaluateExpr('notes', { notes: 'x' }), true);
  assert.equal(evaluateExpr('orders or nulls', { orders: false, nulls: 1 }), true);
});

test('the grammar is unchanged: keywords, negative numbers, no arithmetic', () => {
  assert.equal(evaluateExpr('not true or false', {}), false);
  assert.equal(evaluateExpr('x > -1', { x: 0 }), true);
  assert.equal(evaluateExpr('x>-1', { x: 0 }), true);
  assert.equal(evaluateExpr('x == null', { x: null }), true);
  assert.throws(() => evaluateExpr('x - 1', { x: 2 }));
  assert.throws(() => evaluateExpr('x + 1', { x: 2 }));
  // `x-1` is now one identifier, absent from the context: falsy, never a subtraction.
  assert.equal(evaluateExpr('x-1', { x: 2 }), false);
});
