/**
 * The road a plugin's speech pack takes from the desktop's main process
 * (TODO #584), on a real Electron: `session.fetch` from the window's session,
 * with the options `fetchPluginPack` passes (pinned by `speech-ipc.test.ts`),
 * carries the HttpOnly session cookie the daemon sets, and follows no redirect.
 * Without that cookie every pack would read as `unavailable` in the package.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const PACK_PATH = '/api/ui/plugins/acme/-/dictation-models';

test('the main process reads a pack with the window\'s session cookie, and follows no redirect', {
  skip: process.env.TIMON_ELECTRON_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'timon-pack-smoke-'));
  const electron = createRequire(import.meta.url)('electron') as string;
  const cookies: (string | undefined)[] = [];
  const trapped: string[] = [];
  const app = http.createServer((req, res) => {
    if (req.url === PACK_PATH) {
      cookies.push(req.headers.cookie);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ pluginId: 'acme', version: '1.0.0', models: [{ id: 'acme.x' }] }));
      return;
    }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/trap' }); res.end(); return; }
    if (req.url === '/trap') { trapped.push(req.url); res.end('followed'); return; }
    // Same attributes as `serializeSessionCookie` (`orchestrator/src/users/session.ts`).
    res.setHeader('set-cookie', 'timon_session=the-user; Path=/; HttpOnly; SameSite=Lax');
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Timon</title>');
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  try {
    await writeFile(join(home, 'smoke.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
const fail=(e)=>{fs.writeSync(2,(e&&e.stack||String(e))+'\\n');app.exit(1)};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
app.on('window-all-closed',()=>{});app.setPath('userData',process.env.TIMON_HOME+'/shell');
const read=(s,url)=>s.fetch(url,{credentials:'include',redirect:'manual',signal:AbortSignal.timeout(10000)});
(async()=>{
await app.whenReady();app.dock?.hide();
const origin=process.env.PACK_SMOKE_ORIGIN;
const w=new BrowserWindow({show:false});
await w.loadURL(origin+'/');
const s=w.webContents.session;
const pack=await read(s,origin+${JSON.stringify(PACK_PATH)});
const out={status:pack.status,body:await pack.json()};
out.redirect=await read(s,origin+'/redirect').then((r)=>r.status,()=>'rejected');
console.log('PACK_SMOKE '+JSON.stringify(out));
app.exit(0);
})().catch(fail);
`);
    const result = await promisify(execFile)(electron, [join(home, 'smoke.cjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TIMON_HOME: home, PACK_SMOKE_ORIGIN: origin }, timeout: 55_000, maxBuffer: 2 * 1024 * 1024,
    }).catch((error) => { throw new Error(`pack smoke failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    const line = /PACK_SMOKE (.*)/.exec(result.stdout)?.[1];
    assert.ok(line, result.stdout);
    const out = JSON.parse(line) as { status: number; body: { pluginId: string }; redirect: number | string };
    assert.equal(out.status, 200);
    assert.equal(out.body.pluginId, 'acme');
    assert.deepEqual(cookies, ['timon_session=the-user'], 'the HttpOnly cookie of the window travels with the read');
    assert.notEqual(out.redirect, 200);
    assert.deepEqual(trapped, [], 'a redirect is not followed');
    console.log(line);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
