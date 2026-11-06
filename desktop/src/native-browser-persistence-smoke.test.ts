import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import ts from 'typescript';

const MODULES = ['native-browser', 'native-browser-protocol', 'native-browser-credentials', 'native-browser-user-agent',
  'native-browser-devtools', 'native-browser-cookies', 'native-browser-chrome', 'native-browser-chrome-signin', 'native-browser-recorder', 'native-browser-annotator'];

/** One Electron launch over a shared home: `set` signs in then quits (cleanly or killed), `get` reopens and reads the jar. */
const fixture = String.raw`
const { app, session } = require('electron');
const { createServer } = require('node:http');
const { join } = require('node:path');
const home = process.env.TIMON_HOME;
const mode = process.env.SMOKE_MODE;
const fail = (error) => { require('node:fs').writeSync(2, String(error?.stack ?? error) + '\n'); app.exit(1); };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
app.setPath('userData', join(home, 'shell'));
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  await app.whenReady();
  app.dock?.hide();
  const { NativeBrowserEngine } = await import('./native-browser.js');
  const engine = new NativeBrowserEngine(home);
  const jar = () => session.fromPath(join(home, 'browser-profiles', 'p', 'electron')).cookies.get({});
  const server = createServer((req, res) => {
    if (req.url === '/chrome') {
      res.setHeader('Set-Cookie', ['from_server=1; Path=/; Max-Age=86400', 'session_only=1; Path=/']);
      res.setHeader('Content-Type', 'text/html');
      res.end('<script>document.cookie = "webdriver=" + navigator.webdriver + "; Max-Age=86400; Path=/"</script>');
      return;
    }
    if (req.url === '/login') res.setHeader('Set-Cookie', ['signed_in=yes; Path=/; HttpOnly', 'remember=1; Path=/; Max-Age=86400']);
    res.setHeader('Content-Type', 'text/html'); res.end('<title>ok</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await engine.command({ profileId: 'p', action: 'start' });
  if (mode === 'chrome') {
    // A real, installed Chrome (headless, so that no display is needed) signs in; its cookies must land in the Electron session.
    const { ChromeSignin, spawnChrome } = await import('./native-browser-chrome-signin.js');
    const signin = new ChromeSignin({ home, exitGraceMs: 10_000, spawn: (file, args) => spawnChrome(file, ['--headless=new', ...args]) });
    const target = session.fromPath(join(home, 'browser-profiles', 'p', 'electron'));
    await signin.start('p', { executable: process.env.TIMON_CHROME_SMOKE, url: 'http://127.0.0.1:' + server.address().port + '/chrome' }, target.cookies);
    await delay(5_000);
    console.log('RESULT ' + JSON.stringify(await signin.finish('p')));
    console.log('VALUES ' + JSON.stringify((await jar()).filter(c => c.name === 'webdriver' || c.name === 'from_server').map(c => c.name + '=' + c.value).sort()));
    console.log('JAR ' + JSON.stringify((await jar()).map(c => c.name + ':' + c.session).sort()));
    await engine.close();
    app.exit(0);
    return;
  }
  if (mode === 'get') {
    console.log('JAR ' + JSON.stringify((await jar()).map(c => c.name + ':' + c.session).sort()));
    await engine.close();
    app.exit(0);
    return;
  }
  await engine.command({ profileId: 'p', action: 'navigate', url: 'http://127.0.0.1:' + server.address().port + '/login' });
  for (let i = 0; i < 100; i++) {
    const kept = (await jar()).find(c => c.name === 'signed_in');
    if (kept && !kept.session) break;
    await delay(50);
  }
  if (mode === 'set-clean') { await engine.close(); app.exit(0); return; }
  // Past the throttled flush, well inside Chromium's own ~30 s commit window.
  await delay(3_500);
  process.kill(process.pid, 'SIGKILL');
})().catch(fail);
`;

test('a session sign-in survives a clean quit and a killed shell', {
  skip: process.env.TIMON_ELECTRON_SMOKE !== '1', timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'timon-native-browser-persistence-'));
  const electron = createRequire(import.meta.url)('electron') as string;
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    for (const name of MODULES) {
      const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      await writeFile(join(root, `${name}.js`), ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText);
    }
    const preloadSource = await readFile(new URL('./native-browser-preload.cts', import.meta.url), 'utf8');
    await writeFile(join(root, 'native-browser-preload.cjs'), ts.transpileModule(preloadSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText);
    new Script(fixture, { filename: 'smoke.cjs' });
    await writeFile(join(root, 'smoke.cjs'), fixture);
    const launch = async (home: string, mode: string): Promise<string> => {
      const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: home, SMOKE_MODE: mode };
      delete env.ELECTRON_RUN_AS_NODE;
      try {
        return (await promisify(execFile)(electron, [join(root, 'smoke.cjs')], { env, timeout: 30_000, killSignal: 'SIGKILL' })).stdout;
      } catch (error) {
        const failure = error as { signal?: string; stdout?: string; stderr?: string };
        if (mode === 'set-kill' && failure.signal === 'SIGKILL') return failure.stdout ?? '';
        throw new Error(`Electron ${mode} failed: ${failure.stdout}\n${failure.stderr}`);
      }
    };
    // Opt-in on top of the Electron smoke: the path of an installed Chrome.
    if (process.env.TIMON_CHROME_SMOKE) {
      const home = await mkdtemp(join(root, 'chrome-'));
      const signedIn = await launch(home, 'chrome');
      assert.match(signedIn, /RESULT \{"state":"finished"/, signedIn);
      assert.match(signedIn, /VALUES \["from_server=1","webdriver=false"\]/, signedIn);
      assert.match(signedIn, /"session_only:false"/, 'a session cookie is stored persistently in the session');
      const reopened = await launch(home, 'get');
      assert.match(reopened, /"session_only:false"/, reopened);
      assert.match(reopened, /"from_server:false"/, reopened);
    }
    for (const quit of ['set-clean', 'set-kill']) {
      const home = await mkdtemp(join(root, `${quit}-`));
      await launch(home, quit);
      const reopened = await launch(home, 'get');
      assert.match(reopened, /JAR \["remember:false","signed_in:false"\]/, `${quit}: ${reopened}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
