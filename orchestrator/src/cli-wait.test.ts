/**
 * `rooks wait` rend la main à la FIN DU TOUR, et ne re-télécharge pas le
 * transcript à chaque tour de boucle (fiche #101, 17/09/2026).
 *
 * Témoin HTTP sur `127.0.0.1:0`, jamais le daemon de la machine. Le serveur
 * rejoue ce qu'un backend persistant produit : `status: running` pour toujours,
 * `turn_complete` qui bascule à vrai quand l'agent a fini d'écrire.
 *
 * `node --test --import tsx src/cli-wait.test.ts`
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-cli-wait-test-'));

const ROOKS = fileURLToPath(new URL('../bin/rooks', import.meta.url));
const MISSION = 'd4d95593-d364-4181-8a31-13d425724f03';

const EVENTS = [
  { type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'premier tour' }] } } },
  { type: 'user', payload: { message: { content: 'une relance' } } },
  { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } } },
  // Le stream persiste AUSSI ses résultats d'outil en events `user` : découper
  // dessus ne rendrait que ce qui suit le dernier outil.
  { type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } } },
  { type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'second tour' }] } } },
  { type: 'result', payload: { subtype: 'success' } },
];

/** Mock daemon: `turnsAfter` light polls before the turn is declared over. */
function startMock(turnsAfter: number, events: unknown[] = EVENTS): Promise<{
  url: string;
  urls: string[];
  close: () => Promise<void>;
}> {
  const urls: string[] = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    urls.push(url);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (url.includes('view=status')) {
      polls += 1;
      // A persistent backend never leaves `running` before the idle reap.
      res.end(JSON.stringify({
        id: MISSION, status: 'running', turn_complete: polls > turnsAfter, turn_active: false,
      }));
      return;
    }
    res.end(JSON.stringify({ id: MISSION, status: 'running', events }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        urls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function runNova(args: string[], api: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ROOKS_API: api, ROOKS_RESOURCE_GUARD_ENABLED: '0' };
    delete env.ROOKS_API_TOKEN;
    const child = spawn(process.execPath, [ROOKS, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test('rend la main sur la fin du tour, sans attendre la mort du process', async () => {
  const mock = await startMock(1);
  try {
    const r = await runNova(['wait', MISSION, '--timeout=20'], mock.url);
    assert.equal(r.code, 0);
    // Le tour courant seulement : un pilote qui attend deux fois la même
    // mission ne doit pas se voir resservir tout l'historique.
    assert.equal(r.stdout.trim(), 'second tour');
  } finally {
    await mock.close();
  }
});

test('la boucle interroge la vue légère, le transcript une seule fois', async () => {
  const mock = await startMock(2);
  try {
    await runNova(['wait', MISSION, '--timeout=20'], mock.url);
    const light = mock.urls.filter((u) => u.includes('view=status'));
    const full = mock.urls.filter((u) => !u.includes('view=status'));
    assert.equal(light.length, 3);
    assert.equal(full.length, 1, 'le transcript ne se télécharge qu\'au moment de l\'imprimer');
  } finally {
    await mock.close();
  }
});

test('--json rend toujours la mission complète', async () => {
  const mock = await startMock(0);
  try {
    const r = await runNova(['wait', MISSION, '--timeout=20', '--json'], mock.url);
    const body = JSON.parse(r.stdout) as { id: string; events: unknown[] };
    assert.equal(body.id, MISSION);
    assert.equal(body.events.length, EVENTS.length);
  } finally {
    await mock.close();
  }
});

test('un tour qui finit sur un outil rend l\'historique plutôt que rien', async () => {
  const mute = EVENTS.slice(0, 4); // pas de texte après le dernier tool_result
  const mock = await startMock(1, [...mute, { type: 'result', payload: { subtype: 'success' } }]);
  try {
    const r = await runNova(['wait', MISSION, '--timeout=20'], mock.url);
    assert.match(r.stdout, /premier tour/);
  } finally {
    await mock.close();
  }
});
