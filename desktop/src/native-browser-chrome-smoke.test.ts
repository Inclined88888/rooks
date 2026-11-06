import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CookiesSetDetails } from 'electron';
import { ChromeSignin, spawnChrome } from './native-browser-chrome-signin.js';

/**
 * Opt-in: starts a real, installed Chrome (`TIMON_CHROME_SMOKE=<path to the binary>`) with the
 * flags the sign-in flow uses, headless so that no display is needed. The page records what the
 * browser reports about itself in a cookie, which is then read back over the DevTools pipe.
 */
test('a real Chrome signs in over the pipe, reports no automation, and hands its cookies over', {
  skip: !process.env.TIMON_CHROME_SMOKE, timeout: 60_000,
}, async (t) => {
  const executable = process.env.TIMON_CHROME_SMOKE!;
  const home = mkdtempSync(join(tmpdir(), 'timon-chrome-smoke-'));
  const server = createServer((_request, response) => {
    response.setHeader('Set-Cookie', ['from_server=1; Max-Age=3600; Path=/', 'session_only=1; Path=/']);
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><script>document.cookie = "webdriver=" + navigator.webdriver + "; Max-Age=3600; Path=/"</script>ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
  const { port } = server.address() as { port: number };
  const stored: CookiesSetDetails[] = [];
  const signin = new ChromeSignin({
    home, exitGraceMs: 10_000,
    spawn: (file, args) => spawnChrome(file, ['--headless=new', ...args]),
  });
  await signin.start('bp-smoke', { executable, url: `http://127.0.0.1:${port}/` }, { set: async (details) => { stored.push(details); } });
  // The page runs within a second of loading; two poll periods leave a margin for a cold profile.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const result = await signin.finish('bp-smoke');
  assert.equal(result.state, 'finished');
  const byName = new Map(stored.map((cookie) => [cookie.name, cookie]));
  assert.equal(byName.get('from_server')?.value, '1');
  assert.equal(byName.get('webdriver')?.value, 'false', 'navigator.webdriver must be false');
  // A session cookie becomes a persistent one so that it survives the app restarting.
  assert.ok((byName.get('session_only')?.expirationDate ?? 0) > Date.now() / 1000 + 86_400);
});
