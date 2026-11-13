import assert from 'node:assert/strict';
import test from 'node:test';
import { htmlFailureAsJson } from './proxy-errors';

test('an HTML error page from the daemon becomes a JSON error the client can read', () => {
  const missing = htmlFailureAsJson(404, 'text/html; charset=utf-8', false)!;
  assert.equal(missing.status, 404);
  assert.match(JSON.parse(missing.body).error, /module that serves it is turned off/);
  assert.match(JSON.parse(htmlFailureAsJson(502, 'text/html', false)!.body).error, /HTTP 502/);
});

test('both carry a code the webview translates, the status as a param', () => {
  assert.equal(JSON.parse(htmlFailureAsJson(404, 'text/html', false)!.body).code, 'module_unavailable');
  const failed = JSON.parse(htmlFailureAsJson(502, 'text/html', false)!.body);
  assert.deepEqual([failed.code, failed.params], ['daemon_html_response', { status: 502 }]);
});

test('JSON bodies and successful answers pass through untouched', () => {
  assert.equal(htmlFailureAsJson(404, 'application/json; charset=utf-8', false), null);
  assert.equal(htmlFailureAsJson(200, 'text/html', true), null);
  assert.equal(htmlFailureAsJson(404, null, false), null);
});
