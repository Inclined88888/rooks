/**
 * Bascule de backend sur quota épuisé, et identité des séries Kanban.
 *
 * Ce qui est vérifié ici est ce qui a manqué le 2026-08-20 : un backend à sec
 * doit devenir un ÉTAT connu du système (sinon chaque spawn repart dans le
 * mur), et un chantier doit garder une identité stable quand son pilote change
 * (sinon on ne sait plus quelles tasks déplacer, ni où livrer les retours).
 *
 * La base est ouverte dans un TIMON_HOME temporaire : les imports sont donc
 * dynamiques, APRÈS avoir posé l'environnement.
 *
 * `node --test --import tsx src/backend-fallback.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-fallback-test-'));
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = 'codex';
process.env.TIMON_FALLBACK_MODEL = '';
process.env.TIMON_FALLBACK_COOLDOWN_MS = '3600000';
// `ollama-cloud` only exists as a backend when its key is in the env (profile
// `requiredEnv`, cf. backends/registry.ts). The last test below relies on it,
// and passed only on a shell that happened to carry the real key: neither a
// mission nor CI does. A dummy value is enough, nothing is ever called.
process.env.OLLAMA_API_KEY ??= 'test-key';

const { dbApi } = await import('./db.js');
const { mountOfficialProviders, stubCliBinaries } = await import('../tests/helpers/official-providers.js');
await stubCliBinaries('grok');
await mountOfficialProviders();
const {
  noteBackendRateLimit,
  clearBackendCooldown,
  isBackendCoolingDown,
  fallbackFor,
  redirectIfExhausted,
  cooldownReason,
} = await import('./backend-fallback.js');
const { setBackendBinaryAvailabilityForTest } = await import('./backends/binary-check.js');
// The cascade skips a backend whose CLI is missing: these tests must not
// depend on the CLIs installed on the machine that runs them.
setBackendBinaryAvailabilityForTest(() => true);

const hit = (
  over: Partial<{
    kind: 'rate_limit' | 'exhausted';
    window: string | null;
    resetsAt: number | null;
    source: 'event' | 'status' | 'text';
    pending: boolean;
  }> = {},
) => ({
  kind: 'rate_limit' as const,
  window: 'five_hour',
  resetsAt: null,
  source: 'event' as const,
  pending: false,
  ...over,
});

test('un solde épuisé (402) écarte le backend plus longtemps qu’un quota, et le 429 suivant ne le raccourcit pas', () => {
  clearBackendCooldown('grok');
  const quotaWindow = Date.now() + 3600_000;

  noteBackendRateLimit('grok', hit({ kind: 'exhausted', window: null, source: 'status' }));
  const dry = dbApi.getBackendCooldown('grok');
  assert.equal(dry?.kind, 'exhausted');
  assert.equal(isBackendCoolingDown('grok'), true);
  // Le cooldown "sans crédit" a sa propre durée (24 h par défaut), bien
  // au-delà de la fenêtre de quota configurée ici à 1 h.
  assert.ok((dry?.until ?? 0) > quotaWindow);

  // Un 429 postérieur — même avec l'heure exacte du provider — ne fait pas
  // revenir un compte à sec dans la rotation : rien ne s'est rechargé.
  noteBackendRateLimit('grok', hit({ resetsAt: quotaWindow }));
  assert.equal(dbApi.getBackendCooldown('grok')?.until, dry?.until);
  assert.equal(dbApi.getBackendCooldown('grok')?.kind, 'exhausted');

  // Seul un tour qui aboutit lève l'exclusion : preuve empirique du rechargement.
  clearBackendCooldown('grok');
  assert.equal(isBackendCoolingDown('grok'), false);
});

test('un quota épuisé écarte le backend, un tour réussi le réintègre', () => {
  clearBackendCooldown('claude');
  assert.equal(isBackendCoolingDown('claude'), false);

  noteBackendRateLimit('claude', hit());
  assert.equal(isBackendCoolingDown('claude'), true);

  clearBackendCooldown('claude');
  assert.equal(isBackendCoolingDown('claude'), false);
});

test("l'heure de réouverture du provider fait foi, et un cooldown en cours n'est jamais raccourci", () => {
  clearBackendCooldown('claude');
  const far = Date.now() + 4 * 60 * 60 * 1000;
  noteBackendRateLimit('claude', hit({ resetsAt: far }));
  assert.equal(dbApi.getBackendCooldown('claude')?.until, far);

  // Un second hit annonçant plus tôt ne doit pas relancer les missions dans le
  // mur avant l'heure connue la plus tardive.
  noteBackendRateLimit('claude', hit({ resetsAt: Date.now() + 60_000 }));
  assert.equal(dbApi.getBackendCooldown('claude')?.until, far);
  clearBackendCooldown('claude');
});

test("une estimation ne prolonge pas l'heure exacte annoncée par le provider", () => {
  clearBackendCooldown('claude');
  // Le scénario du 2026-08-22 : l'event `five_hour` annonce 04:40, puis les 429
  // qui suivent n'ont plus d'horodatage. L'estimation "maintenant + cooldown"
  // (1 h dans ce test) tombe APRÈS 04:40 et l'écrasait à chaque 429 — le
  // backend restait écarté des heures après sa réouverture réelle.
  const exact = Date.now() + 20 * 60 * 1000;
  noteBackendRateLimit('claude', hit({ resetsAt: exact }));
  assert.equal(dbApi.getBackendCooldown('claude')?.until, exact);

  noteBackendRateLimit('claude', hit({ resetsAt: null, source: 'status' }));
  assert.equal(
    dbApi.getBackendCooldown('claude')?.until,
    exact,
    "l'estimation ne doit pas repousser l'heure exacte",
  );
  clearBackendCooldown('claude');
});

test("une heure exacte corrige une estimation, même pour la raccourcir", () => {
  clearBackendCooldown('claude');
  noteBackendRateLimit('claude', hit({ resetsAt: null, source: 'status' }));
  const estimated = dbApi.getBackendCooldown('claude')!.until;

  // Le provider finit par annoncer une réouverture PLUS PROCHE que notre
  // estimation : se priver du backend jusqu'à l'estimation serait absurde.
  const exact = Date.now() + 5 * 60 * 1000;
  assert.ok(exact < estimated);
  noteBackendRateLimit('claude', hit({ resetsAt: exact }));
  assert.equal(dbApi.getBackendCooldown('claude')?.until, exact);
  assert.equal(dbApi.getBackendCooldown('claude')?.exact, 1);
  clearBackendCooldown('claude');
});

test('un cooldown périmé est purgé à la lecture', () => {
  dbApi.setBackendCooldown('claude', Date.now() - 1_000, 'five_hour');
  assert.equal(isBackendCoolingDown('claude'), false);
  assert.equal(dbApi.getBackendCooldown('claude'), undefined);
});

test('une requête mise en file ne compte pas comme un quota épuisé', () => {
  clearBackendCooldown('claude');
  // `pending` = le tour peut encore aboutir : écarter le backend serait prématuré.
  noteBackendRateLimit('claude', hit({ pending: true }));
  assert.equal(isBackendCoolingDown('claude'), false);
});

test('le secours ne se substitue pas à lui-même, ni à un backend qui a du quota', () => {
  clearBackendCooldown('claude');
  clearBackendCooldown('codex');
  // Fuir codex pour aller sur codex n'a aucun sens : le réglage fixe pointe
  // pourtant sur codex, donc la cascade doit l'écarter et proposer autre chose.
  clearBackendCooldown('grok');
  assert.notEqual(fallbackFor('codex')?.backend, 'codex');
  // Backend intact : rien à rediriger.
  assert.equal(redirectIfExhausted('claude'), null);

  noteBackendRateLimit('claude', hit());
  assert.deepEqual(redirectIfExhausted('claude')?.backend, 'codex');

  // Secours lui-même à sec : on descend d'un cran dans la cascade plutôt que
  // d'abandonner — il reste peut-être un backend avec du quota.
  noteBackendRateLimit('codex', hit());
  clearBackendCooldown('grok');
  assert.equal(redirectIfExhausted('claude')?.backend, 'grok');

  // Plus AUCUN backend praticable : là seulement, ne rien promettre. Basculer
  // d'un mur vers un autre mur ne ferait que déplacer l'échec.
  noteBackendRateLimit('grok', hit());
  assert.equal(redirectIfExhausted('claude'), null);
  clearBackendCooldown('claude');
  clearBackendCooldown('codex');
  clearBackendCooldown('grok');
});

test("une série garde son identité quand son pilote change d'une mission à l'autre", () => {
  const pilot1 = randomUUID();
  const pilot2 = randomUUID();
  const t1 = randomUUID();
  const t2 = randomUUID();

  dbApi.createTask(t1, 'volet 1', 'a.coder', { creatorMissionId: pilot1, type: 'code' });
  dbApi.createTask(t2, 'volet 2', 'a.coder', { creatorMissionId: pilot1, type: 'code' });

  const seriesId = dbApi.getTask(t1)?.series_id;
  assert.equal(seriesId, pilot1, 'la série prend l\'identité de sa première mission pilote');
  assert.equal(dbApi.getTask(t2)?.series_id, seriesId, 'même pilote → même série');

  // Le pilote change (bascule de backend, ou mission de réveil qui reprend la
  // barre) : les tasks non terminales suivent, l'identité de la série ne bouge pas.
  const moved = dbApi.remapSeriesOrchestratorMission(seriesId!, pilot1, pilot2);
  assert.equal(moved, 2);
  assert.equal(dbApi.getTask(t1)?.creator_mission_id, pilot2);
  assert.equal(dbApi.getTask(t1)?.series_id, seriesId);
  assert.equal(dbApi.seriesIdForMission(pilot2), seriesId);

  // Une task créée ensuite par le NOUVEAU pilote rejoint la même série — sans
  // ça, un chantier se scinderait en deux à chaque bascule.
  const t3 = randomUUID();
  dbApi.createTask(t3, 'volet 3', 'a.coder', { creatorMissionId: pilot2, type: 'code' });
  assert.equal(dbApi.getTask(t3)?.series_id, seriesId);
});

test('la bascule LLM d\'une série épargne les tasks en vol', () => {
  const pilot = randomUUID();
  const todo = randomUUID();
  const running = randomUUID();
  dbApi.createTask(todo, 'pas encore lancée', 'a.coder', { creatorMissionId: pilot, type: 'code' });
  dbApi.createTask(running, 'en vol', 'a.coder', { creatorMissionId: pilot, type: 'code' });
  dbApi.setTaskStatusOnly(running, 'IN_PROGRESS');

  const changed = dbApi.setSeriesLlmOverride(pilot, 'code', 'codex', 'gpt-5.6-sol');
  assert.equal(changed, 1, 'seule la task PENDING est repointée');
  assert.equal(dbApi.getTask(todo)?.backend_override, 'codex');
  // Couper une task qui tourne perdrait son travail alors qu'elle a peut-être
  // encore du quota sur son propre backend.
  assert.equal(dbApi.getTask(running)?.backend_override, null);
});

test('la bascule ne touche que le type visé', () => {
  const pilot = randomUUID();
  const code = randomUUID();
  const review = randomUUID();
  dbApi.createTask(code, 'coder', 'a.coder', { creatorMissionId: pilot, type: 'code' });
  dbApi.createTask(review, 'relire', 'a.reviewer', { creatorMissionId: pilot, type: 'review' });

  dbApi.setSeriesLlmOverride(pilot, 'code', 'codex', 'gpt-5.6-sol');
  assert.equal(dbApi.getTask(code)?.model_override, 'gpt-5.6-sol');
  // Un chantier long ne veut pas le même repli pour son coder et pour ses
  // reviews : c'est toute la raison d'être du plan par portée.
  assert.equal(dbApi.getTask(review)?.backend_override, null);
});

test('le plan de série prime sur le réglage global, portée par portée', () => {
  clearBackendCooldown('claude');
  const seriesId = randomUUID();
  // Le global dit codex ; la série veut grok pour son coder.
  dbApi.setSeriesFallback(seriesId, 'code', 'grok', 'grok-4.6');
  assert.deepEqual(fallbackFor('claude', { seriesId, scope: 'code' }), {
    backend: 'grok',
    model: 'grok-4.6',
  });
  // Portée non citée : le global s'applique toujours.
  assert.equal(fallbackFor('claude', { seriesId, scope: 'review' })?.backend, 'codex');
});

test("le joker '*' couvre les types non cités, mais jamais l'orchestrateur", () => {
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, '*', 'grok', 'grok-4.6');
  assert.equal(fallbackFor('claude', { seriesId, scope: 'review' })?.backend, 'grok');
  assert.equal(fallbackFor('claude', { seriesId, scope: 'doc' })?.backend, 'grok');
  // Le repli choisi pour des reviews (souvent un petit modèle) ne convient pas à
  // celui qui tient le plan du chantier : il retombe sur le global, pas sur '*'.
  assert.equal(fallbackFor('claude', { seriesId, scope: 'orchestrator' })?.backend, 'codex');
});

test('une règle sans backend est un refus explicite de basculer', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'code', null, null);
  // Distinct de "pas de règle" : ici on veut que ça s'arrête plutôt que de
  // continuer sur un modèle qui produira du code à refaire.
  assert.equal(fallbackFor('claude', { seriesId, scope: 'code' }), null);
  assert.equal(fallbackFor('claude', { seriesId, scope: 'review' })?.backend, 'codex');
});

test("un plan qui pointe vers un backend à sec fait descendre d'un cran, pas échouer", () => {
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'code', 'grok', null);
  noteBackendRateLimit('grok', hit());
  clearBackendCooldown('codex');
  // "Sinon" veut dire sinon : la décision de l'orchestrateur est
  // inapplicable (sa cible n'a plus de quota), donc l'équivalence prend le
  // relais. Renvoyer null ici arrêtait le chantier alors qu'un backend était
  // disponible.
  const target = fallbackFor('claude', { seriesId, scope: 'code' });
  assert.equal(target?.backend, 'codex');

  // Un refus EXPLICITE, lui, ne cascade jamais : c'est une décision, pas un
  // empêchement.
  const refused = randomUUID();
  dbApi.setSeriesFallback(refused, 'code', null, null);
  assert.equal(fallbackFor('claude', { seriesId: refused, scope: 'code' }), null);
  clearBackendCooldown('grok');
});

test("le secours posé sur UNE task prime sur la série et sur le réglage global", () => {
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'code', 'grok', 'grok-4.6');
  // La task veut codex/gpt-5.6-terra, la série dit grok, le global dit codex
  // (sans modèle précis) : c'est le modèle EXPLICITE de la task qui doit
  // ressortir, pas celui déduit de la série ou du défaut backend.
  assert.deepEqual(
    fallbackFor('claude', { seriesId, scope: 'code' }, { backend: 'codex', model: 'gpt-5.6-terra' }),
    { backend: 'codex', model: 'gpt-5.6-terra' },
  );
});

test("le sentinel 'none' au niveau task est un refus explicite, même si la série ou le global proposent un secours", () => {
  const seriesId = randomUUID();
  dbApi.setSeriesFallback(seriesId, 'code', 'grok', 'grok-4.6');
  assert.equal(fallbackFor('claude', { seriesId, scope: 'code' }, { backend: 'none', model: null }), null);
  // Sans override task (backend null = "pas d'avis"), la série reprend la main.
  assert.equal(fallbackFor('claude', { seriesId, scope: 'code' }, { backend: null, model: null })?.backend, 'grok');
});

test("l'équivalence passe AVANT le réglage fixe : le calibre d'origine est préservé", () => {
  clearBackendCooldown('claude');
  clearBackendCooldown('codex');
  // TIMON_FALLBACK_BACKEND vaut 'codex' sans modèle : le réglage fixe seul
  // enverrait un petit haiku sur gpt-5.6-sol, le flagship du compte. La
  // matrice, consultée d'abord, respecte le tier d'origine.
  const target = fallbackFor('claude', {
    seriesId: null,
    scope: 'orchestrator',
    fromModel: 'haiku',
  });
  assert.equal(target?.backend, 'codex');
  assert.equal(target?.model, 'gpt-5.6-luna', 'un small doit retomber sur un small');
  assert.notEqual(target?.model, 'gpt-5.6-sol');
});

test("le réglage fixe reste le dernier recours quand l'équivalence ne trouve rien", async () => {
  const { invalidateSettingsCache } = await import('./settings.js');
  clearBackendCooldown('claude');
  // `ollama-cloud` est délibérément absent de FALLBACK_PRIORITY : la matrice
  // ne le choisira JAMAIS d'elle-même (pas de modèles catalogués — trop
  // incertain pour une bascule automatique). L'obtenir prouve donc qu'on est
  // bien descendu jusqu'au réglage fixe, et pas passé par l'équivalence.
  // L'env prime sur la base (cf. buildCache) : c'est lui qu'il faut bouger
  // ici, `setSetting` seul resterait sans effet.
  process.env.TIMON_FALLBACK_BACKEND = 'ollama-cloud';
  invalidateSettingsCache();
  noteBackendRateLimit('codex', hit());
  noteBackendRateLimit('grok', hit());
  try {
    const target = fallbackFor('claude', undefined, undefined);
    assert.equal(target?.backend, 'ollama-cloud');
  } finally {
    process.env.TIMON_FALLBACK_BACKEND = 'codex';
    invalidateSettingsCache();
    clearBackendCooldown('codex');
    clearBackendCooldown('grok');
  }
});

test("aucune config manuelle nulle part : la matrice d'équivalence prend le relais, à tier égal", async () => {
  const { invalidateSettingsCache } = await import('./settings.js');
  // Vider AUSSI l'env : il écrase la base, et tant qu'il vaut 'codex' c'est le
  // réglage fixe qui répond — ce test passait alors sans jamais atteindre la
  // matrice qu'il prétend vérifier.
  delete process.env.TIMON_FALLBACK_BACKEND;
  invalidateSettingsCache();
  try {
    clearBackendCooldown('codex');
    clearBackendCooldown('grok');
    // opus (flagship claude) → un flagship ailleurs, jamais un petit modèle.
    const target = fallbackFor('claude', { seriesId: null, scope: 'orchestrator', fromModel: 'opus' });
    assert.ok(target, 'un secours automatique doit être trouvé');
    assert.notEqual(target?.backend, 'claude');
    assert.equal(target?.model, 'gpt-5.6-sol', 'un flagship doit retomber sur un flagship');
  } finally {
    process.env.TIMON_FALLBACK_BACKEND = 'codex';
    invalidateSettingsCache();
  }
});

test("le pilote ne bouge que si l'orchestrateur est visé ou si SON backend est à sec", async () => {
  const { pilotIsGoverned } = await import('./backend-fallback.js');
  // Chemin automatique (pas de portée) : codex à sec sur les reviews, pilote sur claude.
  assert.equal(pilotIsGoverned(undefined, false), false);
  assert.equal(pilotIsGoverned(undefined, true), true, 'son propre backend est à sec : il part');
  assert.equal(pilotIsGoverned('code', false), false);
  assert.equal(pilotIsGoverned('code', true), true);
  assert.equal(pilotIsGoverned('orchestrator', false), true, 'une règle posée pour lui le déplace');
});

test("codex à sec sur une task : les tasks basculent, le pilote resté sur claude ne bouge pas", async () => {
  const { switchSeriesToFallback } = await import('./backend-fallback.js');
  const pilot = randomUUID();
  dbApi.createMission(pilot, 'a.main', 'pilote');
  dbApi.setMissionLlmOverrides(pilot, 'claude', 'claude-opus-5-5');
  const review = randomUUID();
  dbApi.createTask(review, 'relire', 'a.reviewer', {
    creatorMissionId: pilot, type: 'review', backendOverride: 'codex', modelOverride: 'gpt-5.6-sol',
  });
  const seriesId = dbApi.seriesIdForMission(pilot)!;
  clearBackendCooldown('claude');
  clearBackendCooldown('grok');
  noteBackendRateLimit('codex', hit());
  try {
    await switchSeriesToFallback(seriesId, { pilotMissionId: pilot, reason: 'codex à sec' });
    assert.equal(dbApi.getMission(pilot)?.backend_override, 'claude', 'le pilote garde son backend');
    assert.equal(dbApi.getMission(pilot)?.model_override, 'claude-opus-5-5');
    assert.notEqual(dbApi.getTask(review)?.backend_override, 'codex', 'la task, elle, quitte le backend à sec');
  } finally {
    clearBackendCooldown('codex');
  }
});

test('a fallback target whose CLI is not on this machine is skipped (spawn claude ENOENT, 2026-10-18)', () => {
  clearBackendCooldown('claude');
  clearBackendCooldown('codex');
  clearBackendCooldown('grok');
  noteBackendRateLimit('codex', hit());
  setBackendBinaryAvailabilityForTest((b) => b === 'codex');
  try {
    assert.equal(redirectIfExhausted('codex'), null, 'no installed fallback: nothing promised');
  } finally {
    setBackendBinaryAvailabilityForTest(() => true);
    clearBackendCooldown('codex');
  }
});

test('only a reported limit is called a quota; a breaker cooldown is named as such (TIM-0111)', () => {
  clearBackendCooldown('codex');
  try {
    noteBackendRateLimit('codex', hit());
    assert.equal(cooldownReason('codex'), 'out of quota');
    dbApi.setBackendCooldown('codex', Date.now() + 1_800_000, 'circuit breaker', false, 'unavailable');
    assert.match(cooldownReason('codex'), /^sidelined by the circuit breaker until .+, no quota measured$/);
    dbApi.setBackendCooldown('codex', Date.now() + 1_800_000, 'authentication failed', false, 'unavailable');
    assert.match(cooldownReason('codex'), /^sidelined after an authentication failure until /);
  } finally {
    clearBackendCooldown('codex');
  }
});

test('a fallback target that is installed but signed out is skipped: one signed-in provider means no fallback (rc.8, 20/10/2026)', async () => {
  const { setProviderSignInForTest, resetProviderSignInForTest } = await import('./backends/sign-in-state.js');
  clearBackendCooldown('claude');
  clearBackendCooldown('codex');
  clearBackendCooldown('grok');
  noteBackendRateLimit('codex', hit());
  // claude and grok are on the machine, nobody signed in to them.
  setProviderSignInForTest('claude', false);
  setProviderSignInForTest('grok', false);
  try {
    assert.equal(redirectIfExhausted('codex'), null, 'no signed-in fallback: nothing promised');
    assert.equal(fallbackFor('codex', { seriesId: null, scope: 'code', fromModel: 'gpt-5.6-sol' }), null);
    // Unknown is not signed out: a provider that cannot tell stays a candidate.
    setProviderSignInForTest('claude', null);
    assert.equal(fallbackFor('codex', { seriesId: null, scope: 'code', fromModel: 'gpt-5.6-sol' })?.backend, 'claude');
  } finally {
    resetProviderSignInForTest();
    clearBackendCooldown('codex');
  }
});
