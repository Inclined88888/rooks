/**
 * `mission_egress` and `rooks mission egress` (TODO #590, T3) relay to the same
 * route with the same paging. Kept out of `mcp-cli-parity.test.ts`, whose file
 * budget is already tight under load.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cli, session, withDaemon } from '../tests/helpers/mcp-cli-parity.js';

test('mission egress: the MCP tool and `rooks mission egress` read the same route, with the same paging', async () => {
  await withDaemon(async (base, seen) => {
    await session(base, [{ method: 'tools/call', params: { name: 'mission_egress', arguments: { mission_id: 'm 1', limit: 20, before: 41 } } }]);
    const fromMcp = seen.find((x) => x.url.startsWith('/api/missions/'));
    assert.equal(`${fromMcp?.method} ${fromMcp?.url}`, 'GET /api/missions/m%201/egress?limit=20&before=41');
    seen.length = 0;
    assert.equal((await cli(base, ['mission', 'egress', 'm 1', '--limit', '20', '--before', '41'])).code, 0);
    const fromCli = seen.find((x) => x.url.startsWith('/api/missions/'));
    assert.equal(`${fromCli?.method} ${fromCli?.url}`, 'GET /api/missions/m%201/egress?limit=20&before=41');
    assert.equal((await cli(base, ['mission', 'egress'])).code, 64);
  });
});

test('mission egress: with the proxy off, the MCP tool and the CLI both say the journal is disabled', async () => {
  const body = { notice: 'Connection journal disabled: …', mission_id: 'm', connections: [], hosts: [], proxy: { mode: 'off', listening: false } };
  await withDaemon(async (base) => {
    const [reply] = await session(base, [{ method: 'tools/call', params: { name: 'mission_egress', arguments: { mission_id: 'm' } } }]);
    const text = reply?.result?.content?.[0]?.text ?? '';
    assert.ok(text.includes('journal disabled'), text);
    const fromCli = await cli(base, ['mission', 'egress', 'm']);
    assert.equal(fromCli.code, 0);
    // Once in the JSON, once on stderr for a reader who pipes the JSON away.
    assert.equal(fromCli.out.split('journal disabled').length - 1, 2, fromCli.out);
  }, { status: 200, body });
});
