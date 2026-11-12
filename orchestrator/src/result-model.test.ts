/**
 * The model of a `result` event has two readers: `resultModelOf` (JS, the
 * mission detail) and `resultModelSql` (the `mission_stats` trigger, the
 * mission list). They must agree on every payload shape, or the rail and the
 * conversation name a different model for the same turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resultModelOf, resultModelSql } from './result-model.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const PAYLOADS = [
  '{"model":"opus"}',
  '{"modelID":"gpt-5.5"}',
  '{"model":"opus","modelID":"other"}',
  '{"model":null,"modelID":"fallback"}',
  '{"model":"","modelID":"not used"}',
  '{"model":42,"modelID":"not used"}',
  '{"model":{"id":"x"}}',
  '{"modelID":""}',
  '{"modelID":7}',
  '{}',
  '[]',
  'null',
  '"opus"',
  '42',
  'not json',
  '',
];

test('the SQL twin gives the JS answer on every payload shape', () => {
  const db = new Database(':memory:');
  const stmt = db.prepare(`WITH p(v) AS (SELECT ?) SELECT ${resultModelSql('p.v')} AS m FROM p`);
  for (const payload of PAYLOADS) {
    const sql = (stmt.get(payload) as { m: string | null }).m;
    assert.equal(sql, resultModelOf(payload), `payload ${JSON.stringify(payload)}`);
  }
  db.close();
});
