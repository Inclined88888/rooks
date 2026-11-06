/**
 * Recherche plein-texte dans l'historique des missions.
 *
 * Ce qu'on protège : avant le 2026-08-23, retrouver "la conversation où on a
 * parlé de X" demandait un LIKE manuel au sqlite3 sur 1,3 Go de payloads, sans
 * aucun outil officiel. Les pièges de cette implémentation :
 *   - indexer les `tool_result` (1 Go sur 1,3) noierait la pertinence ;
 *   - une requête OR (celle du recall mémoire) rendrait toutes les missions qui
 *     contiennent l'un des mots — un humain qui tape deux mots en attend un ET ;
 *   - une ponctuation non assainie fait échouer le parseur FTS5 avec une
 *     SqliteError que personne ne peut interpréter ;
 *   - un rattrapage non reprenable ne couvrirait que les missions postérieures
 *     au déploiement, en rendant zéro sans le dire.
 *
 * `node --test --import tsx src/mission-search.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-search-test-'));

const { extractSearchFragments, toMissionFtsQuery, parseTimeBound } = await import('./mission-search.js');
const { dbApi, db } = await import('./db.js');

/* ── extraction ─────────────────────────────────────────────────────────── */

const assistantMsg = (blocks: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });

test('un bloc text assistant est indexé', () => {
  const f = extractSearchFragments('assistant', assistantMsg([{ type: 'text', text: 'on a choisi FTS5' }]));
  assert.deepEqual(f, [{ role: 'assistant', text: 'on a choisi FTS5' }]);
});

test('thinking, tool_use et tool_result restent HORS index', () => {
  assert.deepEqual(
    extractSearchFragments('assistant', assistantMsg([
      { type: 'thinking', thinking: 'réflexion interne', signature: 'CAIS…' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ])),
    [],
  );
  assert.deepEqual(
    extractSearchFragments('user', {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'un dump de 200 ko' }] },
    }),
    [],
  );
});

test('un message user en texte brut (string) est indexé', () => {
  const f = extractSearchFragments('user', { type: 'user', message: { role: 'user', content: 'relance le merge' } });
  assert.deepEqual(f, [{ role: 'user', text: 'relance le merge' }]);
});

test('un payload malformé ne jette pas — l’indexation ne doit jamais casser l’écriture de l’event', () => {
  for (const bad of [null, undefined, 42, 'texte', { message: null }, { message: { content: 7 } }]) {
    assert.deepEqual(extractSearchFragments('assistant', bad), []);
  }
  assert.deepEqual(extractSearchFragments('system', assistantMsg([{ type: 'text', text: 'x' }])), []);
});

test('a spoken GPT-Live turn is indexed under its speaker', () => {
  assert.deepEqual(
    extractSearchFragments('voice_transcript', { type: 'voice_transcript', role: 'user', text: 'on parle du planning' }),
    [{ role: 'user', text: 'on parle du planning' }],
  );
  assert.deepEqual(
    extractSearchFragments('voice_transcript', { type: 'voice_transcript', role: 'voice', text: 'Bien sûr.' }),
    [{ role: 'assistant', text: 'Bien sûr.' }],
  );
  assert.deepEqual(extractSearchFragments('voice_transcript', null), []);
});

/* ── requête FTS ────────────────────────────────────────────────────────── */

test('deux mots = un ET, pas un OU', () => {
  assert.equal(toMissionFtsQuery('fallback quota'), '"fallback" AND "quota"');
});

test('les guillemets délimitent une phrase exacte', () => {
  assert.equal(toMissionFtsQuery('"rate limit" worktree'), '"rate limit" AND "worktree"');
});

test('le suffixe * reste un préfixe FTS5', () => {
  assert.equal(toMissionFtsQuery('worktree*'), '"worktree" *');
});

test('la ponctuation est neutralisée au lieu de faire échouer le parseur', () => {
  const q = toMissionFtsQuery('timon:task -- (merge)');
  assert.ok(q);
  assert.doesNotThrow(() => db.prepare(`SELECT 1 FROM mission_search_fts WHERE text MATCH ?`).all(q));
});

test('une requête sans terme exploitable rend null', () => {
  assert.equal(toMissionFtsQuery('   '), null);
  assert.equal(toMissionFtsQuery('--- !!'), null);
});

/* ── bornes temporelles ─────────────────────────────────────────────────── */

test('parseTimeBound comprend le relatif, l’ISO et les ms', () => {
  const now = Date.parse('2026-08-23T10:00:00Z');
  assert.equal(parseTimeBound('2d', now), now - 2 * 86_400_000);
  assert.equal(parseTimeBound('12h', now), now - 12 * 3_600_000);
  assert.equal(parseTimeBound('2026-08-01T00:00:00Z', now), Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(parseTimeBound(String(now), now), now);
  assert.equal(parseTimeBound('', now), null);
  assert.equal(parseTimeBound('n’importe quoi', now), null);
});

/* ── bout en bout sur la base ───────────────────────────────────────────── */

function seed(agent: string, prompt: string, texts: string[]): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, prompt);
  for (const t of texts) dbApi.insertEvent(id, 'assistant', assistantMsg([{ type: 'text', text: t }]));
  return id;
}

const m1 = seed('alpha.main', 'audit du fallback de quota', [
  'le backend à sec bascule sur son repli au lieu d’arrêter le chantier',
  JSON.stringify({ noise: 'x' }),
]);
const m2 = seed('beta.main', 'refonte du worktree de merge', [
  'la branche est intégrée depuis le worktree, jamais depuis l’arbre principal',
]);
// Bruit : un tool_result volumineux qui contient le mot cherché ne doit PAS
// remonter — c'est précisément ce qu'on refuse d'indexer.
dbApi.insertEvent(m2, 'user', {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y', content: 'quota quota quota' }] },
});

test('le prompt initial de la mission est cherchable', () => {
  const hits = dbApi.searchMissions({ q: 'audit fallback' });
  assert.deepEqual(hits.map((h) => h.mission_id), [m1]);
  assert.equal(hits[0]?.role, 'prompt');
});

test('le texte d’un tour assistant est cherchable, avec extrait et agent', () => {
  const hits = dbApi.searchMissions({ q: 'arbre principal' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.mission_id, m2);
  assert.equal(hits[0]?.agent_name, 'beta.main');
  assert.ok(hits[0]?.snippet.includes('principal'));
});

test('un tool_result n’est jamais un résultat, même s’il contient le mot', () => {
  const hits = dbApi.searchMissions({ q: 'quota' });
  assert.ok(hits.every((h) => h.mission_id === m1), 'seule la mission qui en PARLE remonte');
});

test('une mission qui parle du sujet plusieurs fois rend un hit par fragment', () => {
  // "worktree" est dans le prompt de m2 ET dans un de ses tours assistant :
  // deux extraits distincts, chacun rouvrable à son endroit.
  const hits = dbApi.searchMissions({ q: 'worktree' });
  assert.equal(hits.length, 2);
  assert.deepEqual(new Set(hits.map((h) => h.mission_id)), new Set([m2]));
  assert.deepEqual(new Set(hits.map((h) => h.role)), new Set(['prompt', 'assistant']));
});

test('le filtre par agent restreint sans écraser la requête', () => {
  assert.deepEqual(dbApi.searchMissions({ q: 'worktree', agents: ['alpha.main'] }), []);
  assert.equal(dbApi.searchMissions({ q: 'worktree', agents: ['beta.main'] }).length, 2);
  assert.deepEqual(dbApi.searchMissions({ q: 'worktree', agents: [] }), []);
});

test('les bornes temporelles filtrent sur la date du fragment', () => {
  const now = Date.now();
  assert.equal(dbApi.searchMissions({ q: 'worktree', since: now + 60_000 }).length, 0);
  assert.equal(dbApi.searchMissions({ q: 'worktree', until: now - 60_000 }).length, 0);
  assert.equal(dbApi.searchMissions({ q: 'worktree', since: now - 60_000 }).length, 2);
});

test('le rattrapage est idempotent : le rejouer ne duplique aucun résultat', () => {
  const before = dbApi.searchMissions({ q: 'worktree' }).length;
  assert.equal(before, 2);
  // curseur remis à zéro = tout l'historique repassé à l'indexeur
  db.prepare(`UPDATE mission_search_state SET v = 0 WHERE k = 'event_cursor'`).run();
  let guard = 0;
  while (!dbApi.reindexMissionSearch(50).done && guard++ < 100) { /* boucle de rattrapage */ }
  assert.equal(dbApi.searchMissions({ q: 'worktree' }).length, before);
  assert.equal(dbApi.missionSearchProgress().done, true);
});

test('un event supprimé de l’index ne laisse pas de fragment orphelin', () => {
  const id = seed('gamma.main', 'mission jetable', ['terme éphémère indexé']);
  assert.equal(dbApi.searchMissions({ q: 'éphémère' }).length, 1);
  db.prepare(`DELETE FROM mission_search WHERE mission_id = ?`).run(id);
  assert.equal(dbApi.searchMissions({ q: 'éphémère' }).length, 0);
});
