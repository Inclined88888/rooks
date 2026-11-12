import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { inspectListenPort } from './listen-port.js';
import type { Host } from './types.js';

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  test(`occupied port reports a PID through the ${platform} host adapter`, async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    const host: Pick<Host, 'platform' | 'execAsync'> = {
      platform,
      execAsync: async (command, args, opts) => {
        assert.ok(opts?.timeout);
        assert.ok(args.length > 0);
        if (command === 'ps' || command === 'tasklist') {
          assert.ok(!args.includes('-ww') && !args.includes('args='), 'executable name only, never the command line');
          return { code: 0, stderr: '', stdout: platform === 'win32' ? '"Rooks.exe","1234","Console","1","50 K"' : '/Applications/Rooks.app/Contents/MacOS/Rooks\n' };
        }
        assert.equal(command, platform === 'win32' ? 'netstat' : 'lsof');
        return { code: 0, stderr: '', stdout: platform === 'win32' ? `TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING 1234\r\nTCP 127.0.0.1:1 0.0.0.0:0 LISTENING 9999` : '1234\n' };
      },
    };
    try {
      const state = await inspectListenPort(host, '127.0.0.1', port);
      assert.equal(state.available, false);
      assert.match(state.detail, /PID\(s\) 1234 \[.*Rooks/);
      assert.ok(!state.detail.includes('9999'));
      const unknown = await inspectListenPort({ ...host, execAsync: async () => { throw new Error('unavailable'); } }, '127.0.0.1', port);
      assert.equal(unknown.available, false);
      assert.match(unknown.detail, /owner unknown/);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    const state = await inspectListenPort(host, '127.0.0.1', port);
    assert.deepEqual(state, { available: true, detail: 'port available' });
  });
}
