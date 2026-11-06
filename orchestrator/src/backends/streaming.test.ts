/**
 * Streaming du texte partiel d'une réponse d'agent.
 *
 * Deux invariants, dans cet ordre d'importance :
 *
 *  1. RIEN DE SUPERFLU NE SORT DE parseLine. `--include-partial-messages`
 *     ajoute au flux claude une ligne `stream_event` par fragment ET par
 *     transition de bloc. Comme `processEvent` persiste tout ce qui n'est pas
 *     un delta, laisser passer ne serait-ce que les `message_start` ferait
 *     écrire des milliers de lignes par tour dans la table `events`.
 *  2. Le seul type qui ressort est `assistant_delta`, avec le `mode` qui
 *     correspond à la façon dont le CLI émet (claude : incréments → append).
 *
 * Les formes JSON testées ici sont celles réellement observées sur claude-code
 * 2.1.228 et codex-cli 0.147.0, pas des formes supposées.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/* TIMON_HOME jetable, posé avant l'import du registry (paths.js lit l'env au
   chargement) → import dynamique obligatoire. */
const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-streaming-'));
process.env.TIMON_HOME = TMP_HOME;
process.env.CODEX_AUTH_DIR = join(TMP_HOME, 'codex-auth');
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { getBackend, ASSISTANT_DELTA } = await import('./index.js');
const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
type AgentConfig = import('../agent.js').AgentConfig;
type AssistantDeltaPayload = import('./types.js').AssistantDeltaPayload;

const claude = getBackend('claude');
const codex = getBackend('codex');

function spawnOpts(model: string) {
  const cfg: AgentConfig = { cwd: TMP_HOME, model, permission_mode: 'auto' };
  return {
    agentName: 'TIMON.streaming',
    systemPrompt: 'sp',
    message: 'salut',
    resumeSession: null,
    cfg,
    missionId: 'mission-streaming-0001',
  };
}

/** Enveloppe `stream_event` telle que le CLI l'écrit (champs de plomberie
 *  omis : parseLine ne les regarde pas). */
function streamEvent(event: unknown): string {
  return JSON.stringify({
    type: 'stream_event',
    event,
    session_id: 'sess-1',
    parent_tool_use_id: null,
    uuid: 'u-1',
  });
}

/* ── claude ─────────────────────────────────────────────────────────────── */

test('[claude] buildSpawn active --include-partial-messages', async () => {
  const sp = await buildUnderSeal('claude', spawnOpts('opus'));
  assert.ok(
    sp.args.includes('--include-partial-messages'),
    'sans ce flag le CLI n\'émet aucun texte partiel : plus de streaming du tout',
  );
  // Le flag n'a d'effet qu'en stream-json — s'il disparaissait, le flag serait
  // silencieusement inopérant plutôt qu'en erreur.
  const i = sp.args.indexOf('--output-format');
  assert.equal(sp.args[i + 1], 'stream-json');
});

test('[claude] un text_delta devient un assistant_delta en mode append', () => {
  const evs = claude.parseLine(streamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'onjour ! 👋' },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, ASSISTANT_DELTA);
  // Le CLI émet des INCRÉMENTS ("B" puis "onjour ! …") : concaténer, pas
  // remplacer — sinon la bulle n'afficherait que le dernier fragment.
  assert.deepEqual(evs[0]!.payload as AssistantDeltaPayload, {
    text: 'onjour ! 👋',
    mode: 'append',
  });
});

test('[claude] thinking_delta et input_json_delta sont ignorés', () => {
  // On ne streame pas le raisonnement, et les arguments d'un tool_use à
  // moitié sérialisés ne veulent rien dire dans une bulle de chat.
  assert.deepEqual(claude.parseLine(streamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'hmm' },
  })), []);
  assert.deepEqual(claude.parseLine(streamEvent({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"comm' },
  })), []);
});

test('[claude] la plomberie stream_event ne produit aucun event', () => {
  // Ces lignes n'existaient pas avant le flag. Si l'une d'elles ressortait,
  // processEvent l'écrirait en base une par une.
  const noise: unknown[] = [
    { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  for (const event of noise) {
    assert.deepEqual(claude.parseLine(streamEvent(event)), [], JSON.stringify(event));
  }
});

test('[claude] un stream_event malformé ne fait pas tomber le parsing', () => {
  for (const event of [null, 'texte', 42, {}, { type: 'content_block_delta' },
    { type: 'content_block_delta', delta: null },
    { type: 'content_block_delta', delta: { type: 'text_delta' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 123 } },
    // Un fragment vide ne dirait rien à l'UI et déclencherait un rendu pour rien.
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }]) {
    assert.deepEqual(claude.parseLine(streamEvent(event)), [], JSON.stringify(event));
  }
  assert.deepEqual(claude.parseLine('{"type":"stream_event"}'), []);
});

test('[claude] le message assistant complet passe toujours, lui', () => {
  // C'est la seule source persistée : le streaming ne doit pas la court-circuiter.
  const line = JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Bonjour !' }] },
  });
  const evs = claude.parseLine(line);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, 'assistant');
});

/* ── codex ──────────────────────────────────────────────────────────────── */

test('[codex] aucun partiel : item.started/item.updated restent droppés', () => {
  // Constat empirique sur codex-cli 0.147.0 : `codex exec --json` ne produit
  // AUCUN item.started/item.updated — le flux va de turn.started à
  // item.completed d'un bloc. Ce test verrouille l'absence de streaming côté
  // codex (documentée, pas subie) ; il tombera le jour où on mappera ces
  // events, ce qui obligera à re-vérifier si `text` est cumulé ou incrémental.
  const started = JSON.stringify({
    type: 'item.started',
    item: { id: 'item_0', type: 'agent_message', text: 'Bon' },
  });
  const updated = JSON.stringify({
    type: 'item.updated',
    item: { id: 'item_0', type: 'agent_message', text: 'Bonjour' },
  });
  assert.deepEqual(codex.parseLine(started), []);
  assert.deepEqual(codex.parseLine(updated), []);
});

test('[codex] item.completed produit toujours le message assistant complet', () => {
  const line = JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'Bonjour !' },
  });
  const evs = codex.parseLine(line);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, 'assistant');
});

/* ── contrat de non-persistance ─────────────────────────────────────────── */

test('un assistant_delta ne ressemble à aucun type persisté', () => {
  // `processEvent` (agent.ts) court-circuite EXACTEMENT ce type avant
  // insertEvent/appendAgentLog. Le test ne peut pas l'exécuter sans monter un
  // RunningAgent complet (process, DB, mission) ; il verrouille au moins le
  // nom du type, qui est le seul lien entre le dialecte et la branche.
  assert.equal(ASSISTANT_DELTA, 'assistant_delta');
  for (const persisted of ['assistant', 'user', 'system', 'result']) {
    assert.notEqual(ASSISTANT_DELTA, persisted);
  }
});
