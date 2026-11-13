/**
 * The app window's Content-Security-Policy (TODO #533), enforced by a real
 * Chromium: a page held by it — and a frame or a worker started from a
 * same-origin route that sends its own, looser policy — cannot send a single
 * byte to an origin it did not declare. The policy and the header wiring are
 * the app's own code (`app/src/lib/content-security-policy.ts`), loaded as is.
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

type CspModule = {
  contentSecurityPolicy(opts: { egressHosts: readonly string[]; dev: boolean; selfHost?: string | null }): string;
  enforceContentSecurityPolicy(res: http.ServerResponse, policy: string): void;
};

const LOOSE = 'default-src * data: blob: \'unsafe-inline\'';

function page(outside: string): string {
  return `<!doctype html><meta charset="utf-8"><iframe id="f" name="f" src="/loose-frame"></iframe><script>
const out=${JSON.stringify(outside)};const r={};window.__r=r;window.violations=[];
const frameResult=new Promise(res=>addEventListener('message',e=>{if(e.data&&e.data.name==='frame')res(e.data.result)}));
document.addEventListener('securitypolicyviolation',e=>violations.push(e.effectiveDirective));
const settle=(p,ms=1500)=>Promise.race([p.then(()=>'sent',()=>'blocked'),new Promise(res=>setTimeout(()=>res('blocked'),ms))]);
(async()=>{
  r.self=(await fetch('/ok')).ok;
  r.fetch=await settle(fetch(out+'/fetch',{mode:'no-cors'}));
  r.xhr=await settle(new Promise((ok,ko)=>{const x=new XMLHttpRequest();x.open('GET',out+'/xhr');x.onload=ok;x.onerror=ko;x.send()}));
  try{r.beacon=navigator.sendBeacon(out+'/beacon','voice')?'queued':'refused'}catch{r.beacon='blocked'}
  r.image=await settle(new Promise((ok,ko)=>{const i=new Image();i.onload=ok;i.onerror=ko;i.src=out+'/img'}));
  r.websocket=await settle(new Promise((ok,ko)=>{try{const w=new WebSocket(out.replace('http','ws')+'/ws');w.onopen=ok;w.onerror=ko}catch(e){ko(e)}}));
  r.eventsource=await settle(new Promise((ok,ko)=>{const s=new EventSource(out+'/sse');s.onopen=ok;s.onerror=()=>{s.close();ko()}}));
  const form=document.createElement('form');form.method='POST';form.action=out+'/form';form.target='f';document.body.append(form);
  try{form.submit()}catch{}
  const blob=new Worker(URL.createObjectURL(new Blob(['fetch('+JSON.stringify(out+'/blob-worker')+',{mode:"no-cors"}).then(()=>postMessage("sent"),()=>postMessage("blocked"))'],{type:'text/javascript'})));
  r.blobWorker=await new Promise(res=>blob.onmessage=e=>res(e.data));
  const loose=new Worker('/loose-worker.js');
  r.looseWorker=await new Promise(res=>{loose.onmessage=e=>res(e.data);loose.onerror=()=>res('refused')});
  r.looseFrame=await Promise.race([frameResult,new Promise(res=>setTimeout(()=>res('silent'),1500))]);
  await new Promise(res=>setTimeout(res,500));
  window.__done=r;
})();
</script>`;
}

const FRAME = (outside: string) => `<!doctype html><script>
fetch(${JSON.stringify(outside)}+'/frame',{mode:'no-cors'}).then(()=>'sent',()=>'blocked').then(result=>parent.postMessage({name:'frame',result},'*'));
</script>`;

const WORKER = (outside: string) => `fetch(${JSON.stringify(outside)}+'/loose-worker',{mode:'no-cors'}).then(()=>postMessage('sent'),()=>postMessage('blocked'));`;

test('the window policy leaves no way out to an undeclared origin, in Chromium', {
  skip: process.env.ROOKS_ELECTRON_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const appSrc = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'app', 'src', 'lib', 'content-security-policy.ts');
  const csp = (await import(pathToFileURL(appSrc).href)) as CspModule;
  const home = await mkdtemp(join(tmpdir(), 'rooks-csp-smoke-'));
  const electron = createRequire(import.meta.url)('electron') as string;

  // The origin nothing may reach: any TCP connection counts.
  const reached: string[] = [];
  const outside = http.createServer((req, res) => { reached.push(req.url ?? ''); res.end('leak'); });
  outside.on('connection', () => reached.push('<tcp>'));
  await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', resolve));
  const outsideUrl = `http://127.0.0.1:${(outside.address() as AddressInfo).port}`;

  const app = http.createServer((req, res) => {
    // A declared host, to prove declarations do not open anything else.
    csp.enforceContentSecurityPolicy(res, csp.contentSecurityPolicy({ egressHosts: ['api.declared.example'], dev: false, selfHost: req.headers.host ?? null }));
    if (req.url === '/ok') { res.end('ok'); return; }
    if (req.url === '/loose-frame') { res.setHeader('Content-Security-Policy', LOOSE); res.setHeader('content-type', 'text/html'); res.end(FRAME(outsideUrl)); return; }
    if (req.url === '/loose-worker.js') { res.writeHead(200, { 'Content-Security-Policy': LOOSE, 'content-type': 'text/javascript' }); res.end(WORKER(outsideUrl)); return; }
    res.setHeader('content-type', 'text/html');
    res.end(page(outsideUrl));
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}/`;

  try {
    await writeFile(join(home, 'smoke.cjs'), `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');
const fail=(e)=>{fs.writeSync(2,(e&&e.stack||String(e))+'\\n');app.exit(1)};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
app.on('window-all-closed',()=>{});app.setPath('userData',process.env.ROOKS_HOME+'/shell');
(async()=>{
await app.whenReady();app.dock?.hide();
const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
await w.loadURL(process.env.CSP_SMOKE_URL);
for(let i=0;i<100;i++){const r=await w.webContents.executeJavaScript('window.__done&&JSON.stringify({r:window.__done,v:window.violations})');if(r){console.log('CSP_SMOKE '+r);app.exit(0);return}await new Promise(res=>setTimeout(res,100))}
fail(new Error('page never finished: '+await w.webContents.executeJavaScript('JSON.stringify({r:window.__r,v:window.violations})')));
})().catch(fail);
`);
    const result = await promisify(execFile)(electron, [join(home, 'smoke.cjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ROOKS_HOME: home, CSP_SMOKE_URL: appUrl }, timeout: 55_000, maxBuffer: 2 * 1024 * 1024,
    }).catch((error) => { throw new Error(`CSP smoke failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    const line = /CSP_SMOKE (.*)/.exec(result.stdout)?.[1];
    assert.ok(line, result.stdout);
    const { r, v } = JSON.parse(line) as { r: Record<string, unknown>; v: string[] };
    assert.equal(r.self, true, 'the page still reaches its own origin');
    for (const channel of ['fetch', 'xhr', 'image', 'websocket', 'eventsource', 'blobWorker', 'looseWorker', 'looseFrame']) {
      assert.notEqual(r[channel], 'sent', `${channel} reached the outside`);
    }
    // `sendBeacon` answers `true` once queued, before CSP is checked: the
    // outside server's silence below is what proves it never left.
    assert.deepEqual(reached, [], `the undeclared origin was reached: ${reached.join(', ')}`);
    assert.ok(v.includes('connect-src'), `violations: ${v.join(', ')}`);
    console.log(line);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => outside.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
