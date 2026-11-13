/**
 * Registre vivant des backends (§10.15) — ce qu'un plugin fournisseur peut
 * ajouter, et ce qui disparaît quand il s'en va.
 *
 * L'invariant qui compte n'est pas "on peut ajouter un backend" mais son
 * symétrique : un plugin déchargé ne doit plus rien laisser de dispatchable.
 * Un backend fantôme accepté par `isBackendName` enverrait des tasks vers un
 * dialecte démonté — elles échoueraient au spawn, loin de la désinstallation
 * qui les a causées.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-registry-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { registerDialect, registerProfile, registeredBackendOwners } = await import('./registry.js');
const { backendNames, getBackend, isBackendName, backendCatalog } = await import('./index.js');
type Dialect = import('./types.js').Dialect;
type NormalizedEvent = import('./types.js').NormalizedEvent;
type SessionInfo = import('./types.js').SessionInfo;

/**
 * Dialecte minimal, à la forme exacte du contrat : un CLI one-shot qui parle
 * JSON par ligne. Le même que le gabarit `examples/plugin-provider`.
 */
const echoDialect: Dialect = {
  defaultCmd: 'echo',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: true,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  async buildSpawn(opts, profile) {
    const args = ['--model', opts.cfg.model ?? 'echo-1', '--system', opts.systemPrompt, opts.message];
    if (opts.resumeSession) args.push('--resume', opts.resumeSession);
    return { cmd: profile.cmd, args, env: profile.env, cwd: opts.cfg.cwd, initialStdin: null };
  },
  writeUserInput() { /* one-shot: chaque tour est un process */ },
  parseLine(line: string): NormalizedEvent[] {
    let row: { type?: string; session?: string; text?: string } | null = null;
    try { row = JSON.parse(line) as typeof row; } catch { return []; }
    if (!row || typeof row !== 'object') return [];
    if (row.type === 'init') return [{ type: 'system', payload: { subtype: 'init', session_id: row.session } }];
    if (row.type === 'text') return [{ type: 'assistant', payload: { text: row.text } }];
    if (row.type === 'done') return [{ type: 'result', payload: { subtype: 'success', is_error: false } }];
    return [];
  },
  extractSessionId(ev: NormalizedEvent): string | null {
    const payload = ev.payload as { subtype?: string; session_id?: unknown } | null;
    if (ev.type !== 'system' || payload?.subtype !== 'init') return null;
    return typeof payload.session_id === 'string' ? payload.session_id : null;
  },
};

const profile = {
  id: 'acme-llm',
  dialect: 'acme-echo',
  label: 'ACME LLM',
  vendor: 'ACME',
  custom: true,
  defaultModel: 'acme-1',
  models: [{ slug: 'acme-1', label: 'acme-1' }],
  env: { ACME_API_KEY: 'resolved-by-the-plugin' },
};

test('un plugin ajoute son fournisseur, et le retire en partant', async () => {
  assert.equal(isBackendName('acme-llm'), false, 'rien avant enregistrement');

  const removeDialect = registerDialect('acme-plugin', 'acme-echo', echoDialect);
  const removeProfile = registerProfile('acme-plugin', profile);

  assert.ok(backendNames().includes('acme-llm'), 'le backend est dispatchable');
  assert.equal(isBackendName('acme-llm'), true);
  assert.ok(backendCatalog().some((b) => b.id === 'acme-llm'), 'et visible au catalogue');
  assert.deepEqual(registeredBackendOwners(), {
    profiles: { 'acme-llm': 'acme-plugin' },
    dialects: { 'acme-echo': 'acme-plugin' },
  });

  // Le daemon a bien lié profil et dialecte : le spawn part avec l'env que le
  // plugin a résolu lui-même, et l'init s'annonce sous le nom du PROFIL.
  const backend = getBackend('acme-llm');
  const spawned = await backend.buildSpawn({
    agentName: 'rooks.test', systemPrompt: 'sys', message: 'msg',
    resumeSession: null, cfg: { cwd: TMP_HOME, model: 'acme-1', permission_mode: 'auto' },
    missionId: 'mission-1',
  });
  assert.equal(spawned.cmd, 'echo');
  assert.equal(spawned.env?.ACME_API_KEY, 'resolved-by-the-plugin');
  const [init] = backend.parseLine('{"type":"init","session":"s-1"}');
  assert.equal((init?.payload as { backend?: string }).backend, 'acme-llm');
  assert.equal(backend.extractSessionId(init!), 's-1');

  // Déchargement : plus rien de dispatchable, dans le registre comme au
  // catalogue. C'est `isBackendName` qui refuse une task visant ce backend.
  removeProfile();
  removeDialect();
  assert.equal(isBackendName('acme-llm'), false, 'un plugin déchargé ne laisse pas de backend fantôme');
  assert.equal(backendCatalog().some((b) => b.id === 'acme-llm'), false);
  assert.deepEqual(registeredBackendOwners(), { profiles: {}, dialects: {} });
});

test('les collisions sont refusées en nommant qui occupe la place', () => {
  const remove = registerDialect('first-plugin', 'shared-echo', echoDialect);
  assert.throws(() => registerDialect('second-plugin', 'shared-echo', echoDialect), /first-plugin/);
  // An id alone confers no product trust: an unoccupied dialect name may be registered.
  const release = registerDialect('release-plugin', 'claude', echoDialect);
  assert.throws(() => registerDialect('second-plugin', 'claude', echoDialect), /release-plugin/);
  release();
  assert.throws(() => registerProfile('second-plugin', { ...profile, id: 'claude', dialect: 'shared-echo' }), /product/);
  remove();
});

test('un profil sans dialecte est refusé au lieu de disparaître en silence', () => {
  // Enregistré tel quel, il serait simplement absent d'`activeProfiles` : le
  // plugin croirait son fournisseur installé et ne verrait jamais d'erreur.
  assert.throws(() => registerProfile('acme-plugin', { ...profile, dialect: 'inconnu' }), /inconnu/);
});

test('un dialecte incomplet est refusé avant qu\'une mission ne parte dessus', () => {
  const partial = { ...echoDialect } as Partial<Dialect>;
  delete partial.parseLine;
  assert.throws(() => registerDialect('acme-plugin', 'broken-echo', partial as Dialect), /parseLine/);
});

/* ── Pilote de session bidirectionnel ─────────────────────────────────────
   Un dialecte de test, avec un faux agent scripté au bout de deux PassThrough :
   ni vrai agent, ni transport de production. Ce que ça prouve, c'est la
   PLOMBERIE du contrat : le registre accepte le dialecte, le Backend lié
   expose `openSession` avec l'id du profil, une requête de l'agent traverse
   `host.requestPermission` et sa réponse revient, et la fin de tour est
   émise avant que `prompt` ne résolve. */

/** Agent scripté : répond à la poignée de main, puis à un prompt en posant une
 *  requête de permission qui BLOQUE tant qu'on n'a pas répondu. */
function scriptedAgent(io: { stdin: PassThrough; stdout: PassThrough }, seen: { permissionAnswer?: boolean }): void {
  void (async () => {
    const lines = createInterface({ input: io.stdin });
    const say = (msg: unknown): void => { io.stdout.write(`${JSON.stringify(msg)}\n`); };
    for await (const line of lines) {
      const msg = JSON.parse(line) as { id?: number; method?: string; allow?: boolean };
      if (msg.method === 'initialize') {
        say({ id: msg.id, result: { session: 'sess-1', caps: { loadSession: true, resume: false, mcp: true, image: false } } });
      } else if (msg.method === 'prompt') {
        say({ id: 100, method: 'ask', tool: 'write_file', input: { path: '/etc/passwd' } });
      } else if (msg.id === 100) {
        seen.permissionAnswer = msg.allow;
        say({ method: 'chunk', text: msg.allow ? 'wrote it' : 'refused' });
        say({ id: 2, result: { stopReason: 'end_turn' } });
      }
    }
  })();
}

const sessionDialect: Dialect = {
  ...echoDialect,
  persistentProcess: true,
  finishMissionOnExit: true,
  permissionModel: 'protocol',
  openSession({ io, host, profileId }) {
    const inbox = createInterface({ input: io.stdout })[Symbol.asyncIterator]();
    const send = (msg: unknown): void => { io.stdin.write(`${JSON.stringify(msg)}\n`); };
    const next = async (): Promise<Record<string, unknown>> => {
      const { value, done } = await inbox.next();
      if (done) throw new Error('stream closed');
      return JSON.parse(value as string) as Record<string, unknown>;
    };
    let info: SessionInfo | null = null;
    return {
      get info() { return info; },
      async start() {
        send({ id: 1, method: 'initialize' });
        const { result } = await next() as { result: { session: string; caps: SessionInfo['capabilities'] } };
        info = { sessionId: `${profileId}:${result.session}`, capabilities: result.caps, resumed: false };
        return info;
      },
      async prompt(text) {
        send({ id: 2, method: 'prompt', text });
        for (;;) {
          const msg = await next() as { id?: number; method?: string; tool?: string; input?: unknown; text?: string; result?: { stopReason: string } };
          if (msg.method === 'ask') {
            const decision = await host.requestPermission({ toolCallId: null, tool: msg.tool ?? '', title: null, input: msg.input });
            send({ id: msg.id, allow: decision.allow });
          } else if (msg.method === 'chunk') {
            host.emit({ type: 'assistant', payload: { text: msg.text } });
          } else if (msg.id === 2 && msg.result) {
            host.emit({ type: 'result', payload: { subtype: 'success', is_error: false } });
            return { stopReason: msg.result.stopReason };
          }
        }
      },
      async cancel() { send({ method: 'cancel' }); },
      close() { io.stdin.end(); },
    };
  },
};

test('un dialecte à pilote de session : Backend lié, requête de permission, fin de tour', async () => {
  const removeDialect = registerDialect('acp-like-plugin', 'acp-like', sessionDialect);
  const removeProfile = registerProfile('acp-like-plugin', { ...profile, id: 'acp-llm', dialect: 'acp-like' });
  try {
    const backend = getBackend('acp-llm');
    assert.equal(backend.permissionModel, 'protocol');
    assert.equal(typeof backend.openSession, 'function');
    assert.equal(backendCatalog().find((b) => b.id === 'acp-llm')?.permissionModel, 'protocol');

    const io = { stdin: new PassThrough(), stdout: new PassThrough() };
    const seen: { permissionAnswer?: boolean } = {};
    scriptedAgent(io, seen);

    const events: NormalizedEvent[] = [];
    const asked: unknown[] = [];
    const driver = backend.openSession!({
      // Le pilote lit stdout et écrit stdin, comme avec un ChildProcess : le
      // faux agent tient l'autre bout des deux tuyaux.
      io: { stdin: io.stdin, stdout: io.stdout },
      spawn: {
        agentName: 'rooks.test', systemPrompt: 'sys', message: 'msg', resumeSession: null,
        cfg: { cwd: TMP_HOME, permission_mode: 'auto' }, missionId: 'mission-2',
      },
      host: {
        emit: (ev) => { events.push(ev); },
        requestPermission: async (req) => { asked.push(req); return { allow: false }; },
      },
    });

    assert.equal(driver.info, null, 'rien n\'est connu avant la poignée de main');
    const info = await driver.start();
    assert.equal(info.sessionId, 'acp-llm:sess-1', 'l\'id du profil est lié par le registre');
    assert.deepEqual(driver.info, info);
    assert.deepEqual(info.capabilities, { loadSession: true, resume: false, mcp: true, image: false });

    const outcome = await driver.prompt('go');
    assert.deepEqual(outcome, { stopReason: 'end_turn' });
    assert.deepEqual(asked, [{ toolCallId: null, tool: 'write_file', title: null, input: { path: '/etc/passwd' } }]);
    assert.equal(seen.permissionAnswer, false, 'la décision du host revient à l\'agent');
    assert.deepEqual(events.map((e) => e.type), ['assistant', 'result'], 'la fin de tour est émise avant que prompt ne résolve');
    driver.close();
  } finally {
    removeProfile();
    removeDialect();
  }
  assert.equal(isBackendName('acp-llm'), false);
});

test('un dialecte à pilote sur un process one-shot, ou un openSession qui n\'en est pas un, est refusé', () => {
  assert.throws(
    () => registerDialect('acp-like-plugin', 'oneshot-session', { ...sessionDialect, persistentProcess: false }),
    /persistentProcess/,
  );
  assert.throws(
    () => registerDialect('acp-like-plugin', 'bad-session', { ...sessionDialect, openSession: 'oui' } as unknown as Dialect),
    /openSession/,
  );
});
