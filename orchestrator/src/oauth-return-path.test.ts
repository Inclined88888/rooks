/**
 * The page a finished MCP authorization sends the browser back to comes from a
 * closed list: a caller's path would turn the callback into an open redirect
 * inside the app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oauthReturnPath } from './oauth.js';

test('only the MCP tab and the Apps page are accepted', () => {
  assert.equal(oauthReturnPath('/apps'), '/apps');
  assert.equal(oauthReturnPath('/mcp'), '/mcp');
  for (const value of ['/settings', '//evil.example', 'https://evil.example/apps', '/apps?x=1', '', null, undefined, 3]) {
    assert.equal(oauthReturnPath(value), undefined, String(value));
  }
});
