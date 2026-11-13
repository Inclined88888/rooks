import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import { apiError, sendApiError } from './api-error.js';

test('apiError keeps the English message and adds a stable code', () => {
  assert.deepEqual(apiError('mission_not_found', 'mission not found'), { error: 'mission not found', code: 'mission_not_found' });
});

test('apiError keeps string and finite number params, drops the rest', () => {
  const body = apiError('slug_taken', 'slug already used: acme', {
    slug: 'acme', count: 2, missing: undefined, nan: Number.NaN, nested: { a: 1 }, flag: true,
  });
  assert.deepEqual(body, { error: 'slug already used: acme', code: 'slug_taken', params: { slug: 'acme', count: 2 } });
});

test('apiError omits params when none survive', () => {
  assert.equal('params' in apiError('not_found', 'not found', { x: null }), false);
});

test('apiError refuses a code that is not snake_case', () => {
  for (const bad of ['', 'Not_found', 'not-found', 'not found', 'apiErrors.not_found', '_x', 'x_', '1x']) {
    assert.throws(() => apiError(bad, 'x'), TypeError, bad);
  }
});

test('sendApiError answers with the status and the body', () => {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { sent.status = code; return this; },
    json(body: unknown) { sent.body = body; return this; },
  } as unknown as Response;
  sendApiError(res, 409, 'email_taken', 'email already exists');
  assert.deepEqual(sent, { status: 409, body: { error: 'email already exists', code: 'email_taken' } });
});
