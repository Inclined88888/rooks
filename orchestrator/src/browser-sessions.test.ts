/**
 * Tests de la logique pure des navigateurs embarqués (browser-sessions.ts).
 *
 * `node --test --import tsx src/browser-sessions.test.ts` (ou `npm test`).
 *
 * On ne teste PAS docker : ce qui casse en silence ici, ce sont l'allocation de
 * port (une collision ne se voit qu'au bind, par un message illisible), la
 * réconciliation (jamais exercée à la main) et surtout le bind CDP — un port de
 * debug publié sur 0.0.0.0 fonctionne parfaitement, il est juste ouvert à tout
 * le réseau.
 *
 * Exception: the docker network check (`ensureBrowserNetwork`) takes an
 * injectable runner, so its docker calls are faked here.
 */
// Isole TIMON_HOME AVANT tout module qui touche à l'état TIMON (cf. test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CDP_PORT_RANGE,
  GENERAL_BROWSER_SLUG,
  CHROME_DEVTOOLS_MCP_KEY,
  chromeDevtoolsMcpEntry,
  allocatePort,
  browserPath,
  containerName,
  diffSessions,
  ensureBrowserNetwork,
  hashPages,
  isIdleExpired,
  isRestorablePage,
  isValidSlug,
  missingTabs,
  noteBrowserSessionSpawned,
  parseStoredTabs,
  proxyArgs,
  proxyName,
  routerName,
  runArgs,
  projectMountArgs,
  dockerRunError,
  touchBrowserSessionActivity,
  traefikLabels,
  webProxyArgs,
  webProxyName,
} from './browser-sessions.js';
import type { BrowserSessionStatus, Run } from './browser-sessions.js';
import { dbApi } from './db.js';

/* ── validation du slug ──────────────────────────────────────────────────── */

test('slug : même grammaire que projects.ts', () => {
  assert.ok(isValidSlug('timon'));
  assert.ok(isValidSlug('mail-watch'));
  assert.ok(isValidSlug('example-cms-php'));
  assert.ok(isValidSlug('a.b_c-1'));
});

test('slug : tout ce qui pourrait s’échapper dans un argument docker est refusé', () => {
  assert.ok(!isValidSlug(''));
  assert.ok(!isValidSlug('../../etc'));
  assert.ok(!isValidSlug('timon; rm -rf /'));
  assert.ok(!isValidSlug('timon evil'));
  assert.ok(!isValidSlug('pk/os'));
  assert.ok(!isValidSlug('`whoami`'));
  assert.ok(!isValidSlug('a'.repeat(65)));
});

/* ── allocation de port ──────────────────────────────────────────────────── */

test('port : premier libre de la plage quand rien n’est pris', () => {
  assert.equal(allocatePort(CDP_PORT_RANGE, []), 9300);
});

test('port : saute les ports déjà pris', () => {
  assert.equal(allocatePort(CDP_PORT_RANGE, [9300, 9301, 9303]), 9302);
});

test('port : le port déjà attribué au projet est réutilisé s’il est libre', () => {
  // C'est ce qui rend le port STABLE d'un stop/start à l'autre — un client CDP
  // configuré une fois continue de viser le bon navigateur.
  assert.equal(allocatePort(CDP_PORT_RANGE, [9300, 9301], 9307), 9307);
});

test('port : un préféré occupé ne prime pas — sinon deux projets bindent le même', () => {
  assert.equal(allocatePort(CDP_PORT_RANGE, [9300, 9307], 9307), 9301);
});

test('port : un préféré hors plage est ignoré', () => {
  assert.equal(allocatePort(CDP_PORT_RANGE, [], 22), 9300);
});

test('port : plage saturée → erreur explicite plutôt qu’un port hors plage', () => {
  const all = Array.from({ length: 100 }, (_, i) => 9300 + i);
  assert.throws(() => allocatePort(CDP_PORT_RANGE, all), /no free port in range/);
});

/* ── docker network of the browser ───────────────────────────────────── */

/** Fake docker: answers `network inspect` / `network create` from a script and
 *  records every call. */
function fakeDocker(answers: { inspect: boolean[]; create?: Run }) {
  const calls: string[][] = [];
  const inspect = [...answers.inspect];
  const exec = (args: string[]): Run => {
    calls.push(args);
    if (args[1] === 'inspect') {
      const ok = inspect.shift() ?? false;
      return { ok, out: '', err: ok ? '' : 'Error response from daemon: network traefik_network not found' };
    }
    return answers.create ?? { ok: true, out: 'abc123', err: '' };
  };
  return { exec, calls };
}

test('network: present → nothing is created', () => {
  const d = fakeDocker({ inspect: [true] });
  ensureBrowserNetwork('traefik_network', d.exec);
  assert.deepEqual(d.calls, [['network', 'inspect', 'traefik_network']]);
});

test('network: missing → created under the configured name', () => {
  const d = fakeDocker({ inspect: [false] });
  ensureBrowserNetwork('my_net', d.exec);
  assert.deepEqual(d.calls[1], ['network', 'create', 'my_net']);
  assert.equal(d.calls.length, 2);
});

test('network: create lost a race but the network now exists → no error', () => {
  const d = fakeDocker({
    inspect: [false, true],
    create: { ok: false, out: '', err: 'network with name traefik_network already exists' },
  });
  assert.doesNotThrow(() => ensureBrowserNetwork('traefik_network', d.exec));
  assert.equal(d.calls.length, 3);
});

test('network: unusable → clear error naming the network, the setting and docker\'s message', () => {
  const d = fakeDocker({
    inspect: [false, false],
    create: { ok: false, out: '', err: 'Cannot connect to the Docker daemon' },
  });
  assert.throws(
    () => ensureBrowserNetwork('traefik_network', d.exec),
    (err: Error) => err.message.includes('"traefik_network"')
      && err.message.includes('TIMON_BROWSER_NETWORK')
      && err.message.includes('Cannot connect to the Docker daemon'),
  );
});

/* ── garde-fou d'exposition ──────────────────────────────────────────────── */

test('CDP : publié sur 127.0.0.1 uniquement, jamais sur 0.0.0.0', () => {
  const args = runArgs('timon', 9312);
  const publish = args[args.indexOf('-p') + 1];
  // 9223 = le relais socat, pas Chromium : le débogueur n'écoute que sur la
  // loopback du conteneur (cf. en-tête du module).
  assert.equal(publish, '127.0.0.1:9312:9223');
  // Le garde-fou est le préfixe d'adresse : sans lui docker publie sur 0.0.0.0.
  assert.ok(!args.some((a) => a.includes('0.0.0.0:')));
});

test('le relais CDP partage la pile réseau du navigateur et ne publie rien', () => {
  const args = proxyArgs('timon');
  assert.equal(args[args.indexOf('--network') + 1], 'container:timon-browser-timon');
  // Un `-p` sur le relais serait refusé par docker : les ports se publient sur
  // le conteneur qui possède la pile réseau.
  assert.ok(!args.includes('-p'));
  assert.equal(proxyName('timon'), 'timon-cdp-timon');
  assert.ok(args.includes('tcp-listen:9223,fork,reuseaddr'));
  assert.ok(args.includes('tcp:127.0.0.1:9222'));
  assert.ok(args.includes('timon.browser.proxy=1'));
});

test('le port web (noVNC) n’est PAS publié sur l’host — Traefik le joint par le réseau docker', () => {
  const args = runArgs('timon', 9312);
  const published = args.filter((a, i) => args[i - 1] === '-p');
  assert.equal(published.length, 1);
  assert.ok(!published.some((p) => p.endsWith(':3000')));
  assert.ok(args.includes('--network'));
});

test('le conteneur ne ressuscite pas tout seul au reboot', () => {
  const args = runArgs('timon', 9300);
  assert.equal(args[args.indexOf('--restart') + 1], 'no');
});

test('le profil du projet est monté sur /config', () => {
  const args = runArgs('globex', 9300);
  const mount = args[args.indexOf('-v') + 1] ?? '';
  assert.ok(mount.endsWith('/browser-profiles/globex:/config'), mount);
});

test('le relais web met Traefik au bout de la loopback du navigateur', () => {
  const args = webProxyArgs('timon');
  // Même pile réseau que le navigateur : c'est ce qui fait de ce bind 127.0.0.1
  // SA loopback — celle où atterrit tout `*.localhost` (RFC 6761).
  assert.equal(args[args.indexOf('--network') + 1], 'container:timon-browser-timon');
  assert.equal(webProxyName('timon'), 'timon-web-timon');
  const script = args[args.length - 1] ?? '';
  for (const port of [80, 443]) {
    assert.ok(
      script.includes(`TCP-LISTEN:${port},fork,reuseaddr,bind=127.0.0.1`),
      `port ${port} absent : ${script}`,
    );
    assert.ok(script.includes(`TCP:traefik:${port}`), `cible ${port} absente : ${script}`);
  }
  // Un relais ne publie jamais de port : docker le refuse quand la pile réseau
  // appartient à un autre conteneur.
  assert.ok(!args.includes('-p'));
});

test('le projet est monté au MÊME chemin absolu, en lecture seule', () => {
  // Le chemin identique des deux côtés est ce qui rend `upload_file` utilisable
  // sous Linux et macOS : le chemin de l'agent vaut aussi dans le conteneur.
  const args = runArgs('timon', 9300, process.cwd());
  const mounts = args.filter((a, i) => args[i - 1] === '--mount');
  assert.deepEqual(mounts, [`type=bind,source=${process.cwd()},target=${process.cwd()},readonly`]);
});

test('aucun montage projet quand le chemin est inconnu ou absent du disque', () => {
  // Sans ce garde-fou, docker crée un dossier vide en root à la place du repo.
  for (const path of [null, undefined, '', '/n/existe/pas']) {
    const args = runArgs('timon', 9300, path);
    assert.ok(!args.includes('--mount'), `${path} → ${args.join(' ')}`);
    assert.equal(args.filter((a, i) => args[i - 1] === '-v').length, 1, `${path}`);
  }
});

test('TIM-0120 : sous Windows, source Windows et cible POSIX, sans `:` à découper', () => {
  const exists = () => true;
  assert.deepEqual(projectMountArgs('D:\\Projects\\SamothRAS', 'win32', exists),
    ['--mount', 'type=bind,source=D:\\Projects\\SamothRAS,target=/host/d/Projects/SamothRAS,readonly']);
  assert.deepEqual(projectMountArgs('\\\\nas\\work\\My Site', 'win32', exists),
    ['--mount', 'type=bind,source=\\\\nas\\work\\My Site,target=/host/unc/nas/work/My Site,readonly']);
  // Un chemin qui ne se monte pas (pas de lecteur) ne casse pas le démarrage.
  assert.deepEqual(projectMountArgs('Projects\\X', 'win32', exists), []);
  assert.deepEqual(projectMountArgs('D:\\Projects\\X', 'win32', () => false), []);
});

test('--mount : un chemin contenant une virgule ou un guillemet est cité en CSV', () => {
  assert.deepEqual(projectMountArgs('/srv/a,b "c"', 'linux', () => true),
    ['--mount', 'type=bind,"source=/srv/a,b ""c""","target=/srv/a,b ""c""",readonly']);
});

test('docker run en échec : son stderr remonte dans l’erreur, tronqué', () => {
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    const err = dockerRunError('globex', 'browser', { ok: false, out: '', err: 'docker: Error response from daemon: mount denied\n' });
    assert.equal(err.message, 'docker run of the browser failed: docker: Error response from daemon: mount denied');
    assert.match(logged[0] ?? '', /globex.*mount denied/);
    assert.ok(dockerRunError('globex', 'browser', { ok: false, out: '', err: 'x'.repeat(5000) }).message.length < 1100);
    assert.match(dockerRunError('globex', 'CDP relay', { ok: false, out: '', err: '' }).message, /exit without a message/);
  } finally {
    console.warn = warn;
  }
});

test('Chromium est lancé avec le debug distant ouvert dans le conteneur', () => {
  const cli = runArgs('timon', 9300).find((a) => a.startsWith('CHROME_CLI='));
  assert.ok(cli?.includes('--remote-debugging-port=9222'));
  // Pas de `--remote-debugging-address` : Chromium l'ignore depuis M111 (vérifié
  // sur Chrome 151, il écoute sur 127.0.0.1 quoi qu'on lui passe). Le laisser
  // laisserait croire que le port traverse le mapping alors que non.
  assert.ok(!cli?.includes('--remote-debugging-address'));
});

/* ── nommage et labels Traefik ───────────────────────────────────────────── */

test('nom de conteneur déterministe', () => {
  assert.equal(containerName('timon'), 'timon-browser-timon');
});

test('nom de routeur : les points du slug sont neutralisés', () => {
  // Les clés de label Traefik se découpent sur le point : `routers.a.b.rule`
  // serait interprété comme le routeur `a`, champ `b`, et ignoré.
  assert.equal(routerName('mon.projet'), 'timon-browser-mon-projet');
  assert.equal(routerName('Mail_Watch'), 'timon-browser-mail-watch');
  assert.ok(/^[a-z0-9-]+$/.test(routerName('a.b_C')));
});

test('labels Traefik : règle sur le préfixe, strip du préfixe, port web interne', () => {
  const labels = traefikLabels('timon');
  const rule = labels.find((l) => l.startsWith('traefik.http.routers.timon-browser-timon.rule='));
  assert.ok(rule?.includes('PathPrefix(`/browser/timon`)'), rule);
  assert.ok(rule?.includes('Host(`timon.localhost`)'), rule);
  assert.ok(labels.includes('traefik.enable=true'));
  assert.ok(labels.some((l) => l.endsWith('.stripprefix.prefixes=/browser/timon')));
  assert.ok(labels.some((l) => /loadbalancer\.server\.port=\d+$/.test(l)));
  // Le marqueur d'appartenance : filtre de la réconciliation.
  assert.ok(labels.includes('timon.browser=1'));
});

test('labels Traefik : un routeur http et un routeur https, comme l’app', () => {
  const labels = traefikLabels('timon');
  assert.ok(labels.includes('traefik.http.routers.timon-browser-timon.entrypoints=web'));
  assert.ok(labels.includes('traefik.http.routers.timon-browser-timon-secure.entrypoints=websecure'));
  assert.ok(labels.includes('traefik.http.routers.timon-browser-timon-secure.tls=true'));
});

test('chemin HTTP dérivé du slug', () => {
  assert.equal(browserPath('mail-watch'), '/browser/mail-watch');
});

/* ── réconciliation ──────────────────────────────────────────────────────── */

const row = (project: string, status: 'running' | 'stopped') => ({
  project,
  container_name: `timon-browser-${project}`,
  status,
});

test('réconciliation : aucun écart → aucune correction', () => {
  const d = diffSessions(
    [row('timon', 'running'), row('globex', 'stopped')],
    new Set(['timon-browser-timon']),
  );
  assert.deepEqual(d, { toStop: [], toStart: [] });
});

test('réconciliation : base "running" mais conteneur disparu → stopped', () => {
  const d = diffSessions([row('timon', 'running')], new Set());
  assert.deepEqual(d.toStop, ['timon']);
  assert.deepEqual(d.toStart, []);
});

test('réconciliation : conteneur vivant mais base "stopped" → running', () => {
  // Le cas dangereux : sans ce sens-là, un `start` détruirait un navigateur
  // bien vivant, session de travail comprise.
  const d = diffSessions([row('globex', 'stopped')], new Set(['timon-browser-globex']));
  assert.deepEqual(d.toStart, ['globex']);
  assert.deepEqual(d.toStop, []);
});

test('réconciliation : un conteneur d’un autre projet ne valide pas le mien', () => {
  const d = diffSessions([row('timon', 'running')], new Set(['timon-browser-globex']));
  assert.deepEqual(d.toStop, ['timon']);
});

test('réconciliation : idempotente — rejouée sur l’état corrigé, elle ne fait rien', () => {
  const rows = [row('timon', 'running'), row('globex', 'stopped')];
  const live = new Set<string>();
  const first = diffSessions(rows, live);
  assert.deepEqual(first.toStop, ['timon']);
  const corrected = rows.map((r) =>
    first.toStop.includes(r.project) ? { ...r, status: 'stopped' as const } : r);
  assert.deepEqual(diffSessions(corrected, live), { toStop: [], toStart: [] });
});

/* ── branchement de chrome-devtools-mcp ──────────────────────────────────── */

/** Faux `getBrowserSession` : le branchement se teste sans docker ni base, ce
 *  qui est tout l'intérêt d'avoir sorti la résolution en fonction pure. */
function fakeLookup(sessions: Record<string, { status: string; cdp_url: string }>) {
  const calls: string[] = [];
  const lookup = (slug: string) => {
    calls.push(slug);
    return (sessions[slug] ?? null) as { status: BrowserSessionStatus; cdp_url: string } | null;
  };
  return { lookup, calls };
}

const RUNNING = { timon: { status: 'running', cdp_url: 'http://127.0.0.1:9300' } };

test('mcp : navigateur debout → --browserUrl sur le CDP du projet', () => {
  const { lookup } = fakeLookup(RUNNING);
  const entry = chromeDevtoolsMcpEntry({ project: 'timon' }, lookup);
  assert.ok(entry);
  assert.equal(entry.command, 'npx');
  // L'URL doit suivre IMMÉDIATEMENT le flag : c'est un argv, pas un objet.
  const i = entry.args.indexOf('--browserUrl');
  assert.ok(i >= 0, '--browserUrl absent');
  assert.equal(entry.args[i + 1], 'http://127.0.0.1:9300');
  assert.ok(entry.args.some((a) => a.startsWith('chrome-devtools-mcp')));
});

test('mcp : la clé ne prend pas celle du chrome-devtools de l\'utilisateur', () => {
  // Timon n'impose rien : `chrome-devtools` reste à l'utilisateur, secours si le
  // navigateur intégré casse.
  assert.equal(CHROME_DEVTOOLS_MCP_KEY, 'timon-browser');
});

test('mcp : aucune session → null (repli sur le Chrome local du CLI)', () => {
  const { lookup } = fakeLookup({});
  assert.equal(chromeDevtoolsMcpEntry({ project: 'timon' }, lookup), null);
});

test('mcp : session "stopped" → null, même si elle porte encore son port', () => {
  // La ligne survit à l'arrêt du conteneur (elle porte le port attribué) :
  // sans ce test, on brancherait le MCP sur un port fermé — panne muette.
  const { lookup } = fakeLookup({
    timon: { status: 'stopped', cdp_url: 'http://127.0.0.1:9300' },
  });
  assert.equal(chromeDevtoolsMcpEntry({ project: 'timon' }, lookup), null);
});

test('mcp : le projet est déduit du cwd quand l’agent n’en déclare pas', () => {
  const { lookup, calls } = fakeLookup(RUNNING);
  assert.ok(chromeDevtoolsMcpEntry({ cwd: '/home/user/webdev/projects/timon' }, lookup));
  assert.deepEqual(calls, ['timon']);
});

test('mcp : le projet déclaré prime sur le cwd', () => {
  // Cas des tasks : leur cwd est un worktree `~/.timon/worktrees/<id>`, d'où
  // aucun slug ne se déduit — sans la précédence, aucune task n'aurait de
  // navigateur.
  const { lookup, calls } = fakeLookup(RUNNING);
  assert.ok(chromeDevtoolsMcpEntry(
    { project: 'timon', cwd: '/home/user/.timon/worktrees/abc-123' }, lookup));
  assert.deepEqual(calls, ['timon']);
});

test('mcp : les agents sans projet utilisent le navigateur général s’il tourne', () => {
  const { lookup, calls } = fakeLookup({ [GENERAL_BROWSER_SLUG]: RUNNING.timon });
  for (const ref of [null, {}, { cwd: '/home/user/.timon/worktrees/abc-123' }, { project: '', cwd: '' }]) {
    assert.ok(chromeDevtoolsMcpEntry(ref, lookup));
  }
  assert.deepEqual(calls, Array(4).fill(GENERAL_BROWSER_SLUG));
  assert.equal(chromeDevtoolsMcpEntry({}, () => null), null);
  assert.equal(chromeDevtoolsMcpEntry({}, () => ({ ...RUNNING.timon, status: 'stopped' })), null);
});

test('mcp : sous Windows, le relais traduit les chemins d’upload_file (TIM-0120)', () => {
  const lookup = () => ({ ...RUNNING.timon, status: 'running' as const, project_path: 'D:\\Projects\\X' });
  const entry = chromeDevtoolsMcpEntry({ project: 'timon' }, lookup, 'win32');
  assert.ok(entry);
  assert.equal(entry.command, process.execPath);
  assert.match(entry.args[0] ?? '', /browser-upload-relay-runner\.js$/);
  const spec = JSON.parse(entry.env?.TIMON_BROWSER_RELAY_SPEC ?? '{}');
  assert.equal(spec.command, 'npx');
  assert.deepEqual(spec.args.slice(-2), ['--browserUrl', 'http://127.0.0.1:9300']);
  assert.deepEqual(spec.mount, { source: 'D:\\Projects\\X', target: '/host/d/Projects/X' });
  assert.equal(spec.platform, 'win32');
});

test('mcp : Linux, macOS ou Windows sans projet monté → chrome-devtools-mcp en direct', () => {
  const withPath = () => ({ ...RUNNING.timon, status: 'running' as const, project_path: '/home/user/x' });
  for (const platform of ['linux', 'darwin'] as const) {
    assert.equal(chromeDevtoolsMcpEntry({ project: 'timon' }, withPath, platform)?.command, 'npx');
  }
  const noPath = () => ({ ...RUNNING.timon, status: 'running' as const, project_path: null });
  assert.equal(chromeDevtoolsMcpEntry({ project: 'timon' }, noPath, 'win32')?.command, 'npx');
});

test('le profil général persiste sous TIMON_HOME sans montage du cwd', () => {
  const args = runArgs(GENERAL_BROWSER_SLUG, 9300);
  const mounts = args.filter((_, i) => args[i - 1] === '-v');
  assert.equal(mounts.length, 1);
  assert.ok(mounts[0]?.endsWith(`/browser-profiles/${GENERAL_BROWSER_SLUG}:/config`));
});

test('mcp : un slug hors grammaire est refusé avant toute résolution', () => {
  // Le slug finit dans un argv : il ne doit jamais atteindre la base ni docker
  // sans être passé par `isValidSlug`.
  const { lookup, calls } = fakeLookup(RUNNING);
  assert.equal(chromeDevtoolsMcpEntry({ project: 'timon; rm -rf /' }, lookup), null);
  assert.deepEqual(calls, []);
});

/* ── seuil d'inactivité (isIdleExpired) ──────────────────────────────────── */

test('idle : désactivé (≤0) → jamais expiré, quelle que soit l’ancienneté', () => {
  assert.equal(isIdleExpired({ last_used_at: 0, started_at: 0 }, Date.now(), 0), false);
  assert.equal(isIdleExpired({ last_used_at: 0, started_at: 0 }, Date.now(), -5), false);
});

test('idle : sous le seuil → pas expiré', () => {
  const now = 1_000_000_000_000;
  assert.equal(isIdleExpired({ last_used_at: now - 29 * 60_000, started_at: null }, now, 30), false);
});

test('idle : au-delà du seuil → expiré', () => {
  const now = 1_000_000_000_000;
  assert.equal(isIdleExpired({ last_used_at: now - 31 * 60_000, started_at: null }, now, 30), true);
});

test('idle : pile au seuil → expiré (borne inclusive)', () => {
  const now = 1_000_000_000_000;
  assert.equal(isIdleExpired({ last_used_at: now - 30 * 60_000, started_at: null }, now, 30), true);
});

test('idle : session jamais touchée retombe sur started_at', () => {
  // C'est le cas d'une session qui vient d'ouvrir : aucun signal ne l'a encore
  // bumpée, elle ne doit pas paraître infiniment vieille pour autant.
  const now = 1_000_000_000_000;
  assert.equal(
    isIdleExpired({ last_used_at: null, started_at: now - 2 * 60_000 }, now, 30),
    false,
    'ouverte il y a 2 minutes : jamais en retard',
  );
  assert.equal(
    isIdleExpired({ last_used_at: null, started_at: now - 45 * 60_000 }, now, 30),
    true,
    'ouverte il y a 45 minutes, jamais touchée depuis : expirée',
  );
});

test('idle : ni last_used_at ni started_at → on refuse de fermer plutôt que deviner', () => {
  const now = 1_000_000_000_000;
  assert.equal(isIdleExpired({ last_used_at: null, started_at: null }, now, 30), false);
});

/* ── activité (dbApi, table réelle isolée par test-home.js) ─────────────── */

function seedRunningSession(project: string, startedAt: number): void {
  dbApi.upsertBrowserSession({
    project,
    containerName: containerName(project),
    cdpPort: 9300,
    novncPort: 3000,
    status: 'running',
    startedAt,
    stoppedAt: null,
  });
}

test('activité : une session qui démarre est seedée sur started_at, pas NULL', () => {
  seedRunningSession('seed-a', 12345);
  const row = dbApi.getBrowserSession('seed-a');
  assert.equal(row?.last_used_at, 12345);
});

test('activité : touchBrowserSessionActivity bumpe last_used_at d’une session running', () => {
  seedRunningSession('seed-b', 1000);
  touchBrowserSessionActivity('seed-b', 99999);
  assert.equal(dbApi.getBrowserSession('seed-b')?.last_used_at, 99999);
});

test('activité : touchBrowserSessionActivity est un no-op sur une session arrêtée', () => {
  seedRunningSession('seed-c', 1000);
  dbApi.setBrowserSessionStatus('seed-c', 'stopped', 2000);
  touchBrowserSessionActivity('seed-c', 99999);
  // Un signal en retard ne doit pas ressusciter la fraîcheur d'une ligne
  // éteinte : `last_used_at` reste celui d'avant l'arrêt.
  assert.equal(dbApi.getBrowserSession('seed-c')?.last_used_at, 1000);
});

test('activité : touchBrowserSessionActivity sur un projet sans session n’explose pas', () => {
  assert.doesNotThrow(() => touchBrowserSessionActivity('jamais-ouvert'));
});

test('noteBrowserSessionSpawned : bumpe le projet résolu, running seulement', () => {
  seedRunningSession('seed-d', 1000);
  noteBrowserSessionSpawned({ project: 'seed-d' });
  assert.ok((dbApi.getBrowserSession('seed-d')?.last_used_at ?? 0) > 1000);
});

test('noteBrowserSessionSpawned : un agent orphelin maintient le navigateur général actif', () => {
  seedRunningSession(GENERAL_BROWSER_SLUG, 1000);
  noteBrowserSessionSpawned({});
  assert.ok((dbApi.getBrowserSession(GENERAL_BROWSER_SLUG)?.last_used_at ?? 0) > 1000);
});

test('noteBrowserSessionSpawned : un slug hors grammaire est refusé avant toute résolution', () => {
  assert.doesNotThrow(() => noteBrowserSessionSpawned({ project: 'timon; rm -rf /' }));
});

/* ── pages CDP : filtrage, empreinte ─────────────────────────────────────── */

test('isRestorablePage : garde une page http/https réelle', () => {
  assert.ok(isRestorablePage({ type: 'page', url: 'https://example.com/dashboard' }));
});

test('isRestorablePage : écarte about:blank, les pages internes et les non-pages', () => {
  assert.ok(!isRestorablePage({ type: 'page', url: 'about:blank' }));
  assert.ok(!isRestorablePage({ type: 'page', url: '' }));
  assert.ok(!isRestorablePage({ type: 'page', url: 'chrome://settings' }));
  assert.ok(!isRestorablePage({ type: 'page', url: 'devtools://devtools/bundled/inspector.html' }));
  assert.ok(!isRestorablePage({ type: 'page', url: 'chrome-extension://abc/popup.html' }));
  assert.ok(!isRestorablePage({ type: 'background_page', url: 'https://example.com' }));
  assert.ok(!isRestorablePage({ type: 'service_worker', url: 'https://example.com/sw.js' }));
});

test('hashPages : insensible à l’ordre des onglets', () => {
  const a = [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test', title: 'B' }];
  const b = [{ url: 'https://b.test', title: 'B' }, { url: 'https://a.test', title: 'A' }];
  assert.equal(hashPages(a), hashPages(b));
});

test('hashPages : sensible à un changement de titre (navigation dans le même onglet)', () => {
  const before = [{ url: 'https://a.test', title: 'Chargement…' }];
  const after = [{ url: 'https://a.test', title: 'Tableau de bord' }];
  assert.notEqual(hashPages(before), hashPages(after));
});

test('hashPages : sensible à un onglet en plus ou en moins', () => {
  const one = [{ url: 'https://a.test', title: 'A' }];
  const two = [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test', title: 'B' }];
  assert.notEqual(hashPages(one), hashPages(two));
});

/* ── restauration des onglets (parseStoredTabs, missingTabs — dédup) ────── */

test('parseStoredTabs : lit un JSON valide', () => {
  const raw = JSON.stringify([{ url: 'https://a.test', title: 'A' }]);
  assert.deepEqual(parseStoredTabs(raw), [{ url: 'https://a.test', title: 'A' }]);
});

test('parseStoredTabs : null, JSON invalide, non-tableau ou entrées malformées → liste vide', () => {
  assert.deepEqual(parseStoredTabs(null), []);
  assert.deepEqual(parseStoredTabs('{ pas du json'), []);
  assert.deepEqual(parseStoredTabs('{"url":"https://a.test"}'), [], 'un objet, pas un tableau');
  assert.deepEqual(parseStoredTabs('[{"url":"https://a.test"}]'), [], 'title manquant');
  assert.deepEqual(parseStoredTabs('[{"title":"A"}]'), [], 'url manquante');
  assert.deepEqual(parseStoredTabs('[null, 42, "x"]'), []);
});

test('parseStoredTabs : filtre les entrées invalides sans jeter les valides', () => {
  const raw = JSON.stringify([
    { url: 'https://a.test', title: 'A' },
    { url: 42, title: 'B' },
    { url: 'https://c.test', title: 'C' },
  ]);
  assert.deepEqual(parseStoredTabs(raw), [
    { url: 'https://a.test', title: 'A' },
    { url: 'https://c.test', title: 'C' },
  ]);
});

test('dédup : un onglet déjà restauré par Chromium ne se rouvre pas', () => {
  // C'est le bug explicitement à éviter : chemin naturel + filet actifs en
  // même temps ne doivent jamais doubler un onglet.
  const stored = [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test', title: 'B' }];
  const alreadyOpen = [{ url: 'https://a.test' }, { url: 'https://b.test' }];
  assert.deepEqual(missingTabs(stored, alreadyOpen), []);
});

test('dédup : seuls les onglets manquants sont retenus', () => {
  const stored = [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test', title: 'B' }];
  const alreadyOpen = [{ url: 'https://a.test' }];
  assert.deepEqual(missingTabs(stored, alreadyOpen), [{ url: 'https://b.test', title: 'B' }]);
});

test('dédup : rien de stocké ou rien d’ouvert → cas limites cohérents', () => {
  assert.deepEqual(missingTabs([], [{ url: 'https://a.test' }]), []);
  const stored = [{ url: 'https://a.test', title: 'A' }];
  assert.deepEqual(missingTabs(stored, []), stored);
});

test('dédup : comparaison sur l’URL EXACTE — un paramètre de plus n’est pas un doublon', () => {
  // Documente le choix assumé : un `?utm=` de plus donnerait un faux
  // "manquant" et ouvrirait un doublon quand même (cf. commentaire de
  // `missingTabs`). Pas idéal, mais un faux "manquant" occasionnel est un
  // bien moindre mal qu'une comparaison floue qui masquerait un vrai onglet
  // disparu.
  const stored = [{ url: 'https://a.test/?utm=1', title: 'A' }];
  const alreadyOpen = [{ url: 'https://a.test/' }];
  assert.deepEqual(missingTabs(stored, alreadyOpen), stored);
});
