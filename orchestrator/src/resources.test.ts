/**
 * Garde-fou ressources — logique de profil.
 *
 * On ne teste PAS ici l'interaction systemd (elle exige un manager utilisateur
 * vivant, donc ne tourne pas en CI) mais les décisions qui, elles, se trompent
 * en silence : quelle heure tombe dans quel profil, et le fait qu'un cap "jour"
 * ne puisse JAMAIS être plus permissif que le cap de nuit — une faute de frappe
 * dans les réglages ne doit pas relever un plafond de sécurité.
 */
// Isole TIMON_HOME AVANT tout module qui touche à l'état TIMON (cf. test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Les réglages sont lus via l'env (priorité absolue sur la base) : on les pose
// AVANT l'import du module, qui met en cache la résolution au premier appel.
process.env.TIMON_DAY_START_HOUR = '8';
process.env.TIMON_DAY_END_HOUR = '20';
process.env.TIMON_DAY_MAX_LIVE_MISSIONS = '4';
process.env.TIMON_DAY_MAX_PARALLEL = '2';
process.env.TIMON_MAX_LIVE_MISSIONS = '12';
process.env.TIMON_MAX_PARALLEL = '8';
process.env.TIMON_DAY_CPU_QUOTA_PCT = '400';
process.env.TIMON_NIGHT_CPU_QUOTA_PCT = '1600';

const {
  currentProfile,
  profileLimits,
  missionScopeUnit,
  wrapMissionLaunch,
  stopMissionScopes,
  listMissionScopes,
  systemctlCallCount,
  instancePrefix,
  missionScopePattern,
  grepaiWatcherUnit,
  LEGACY_MISSION_SCOPE_PATTERN,
} = await import('./resources.js');
const { setHasSystemdForTest, setSystemctlForTest } = await import('./host/systemd.js');

const at = (h: number) => new Date(2026, 7, 13, h, 0, 0);

test('la fenêtre jour couvre 8 h–20 h, bornes comprises côté début', () => {
  assert.equal(currentProfile(at(7)), 'night');
  assert.equal(currentProfile(at(8)), 'day');
  assert.equal(currentProfile(at(15)), 'day');
  assert.equal(currentProfile(at(19)), 'day');
  assert.equal(currentProfile(at(20)), 'night');
  assert.equal(currentProfile(at(3)), 'night');
});

test('le profil jour bride CPU et concurrence, la nuit relâche', () => {
  const day = profileLimits(at(15));
  const night = profileLimits(at(3));
  assert.equal(day.cpuQuotaPct, 400);
  assert.equal(night.cpuQuotaPct, 1600);
  assert.equal(day.maxLive, 4);
  assert.equal(night.maxLive, 12);
  assert.equal(day.maxParallel, 2);
  assert.equal(night.maxParallel, 8);
});

test('un cap jour supérieur au cap global est écrêté, jamais appliqué tel quel', async () => {
  // Scénario : réglage jour saisi à 99 par erreur. Le profil "discret" ne doit
  // en aucun cas devenir plus permissif que le plafond global.
  process.env.TIMON_DAY_MAX_LIVE_MISSIONS = '99';
  const { invalidateSettingsCache } = await import('./settings.js');
  invalidateSettingsCache();
  assert.equal(profileLimits(at(15)).maxLive, 12);
  process.env.TIMON_DAY_MAX_LIVE_MISSIONS = '4';
  invalidateSettingsCache();
});

test("les propriétés de l'enveloppe systemd sont en forme longue", () => {
  // Régression : `-p=MemoryMax=12G` est rejeté par systemd-run ("Unknown
  // assignment") et fait échouer le spawn de TOUTES les missions, pas
  // seulement le confinement. Aucun typecheck ne voit une ligne de commande —
  // seule cette assertion (et la sonde au démarrage) protège.
  const { cmd, args } = wrapMissionLaunch('claude', ['--x'], 'aaaaaaaa-0000-4000-8000-000000000000');
  if (cmd !== 'systemd-run') return; // pas de systemd ici (CI) : rien à vérifier
  for (const a of args.filter((v) => v.includes('MemoryMax') || v.includes('CPUWeight'))) {
    assert.match(a, /^--property=/);
  }
  assert.ok(args.includes('--'), 'un séparateur -- doit précéder la commande enveloppée');
  assert.deepEqual(args.slice(-2), ['claude', '--x']);
  const slice = args.find((v) => v.startsWith('--slice='));
  if (slice) assert.equal(slice, `--slice=${instancePrefix()}-missions.slice`);
});

test('le nom de scope est unique par tour et rattachable à sa mission', () => {
  const id = 'b73f0bd2-9c47-489c-9118-0296e6749dbe';
  const a = missionScopeUnit(id);
  const b = missionScopeUnit(id);
  assert.notEqual(a, b, 'deux tours de la même mission ne peuvent pas partager une unit');
  const prefix = instancePrefix();
  for (const u of [a, b]) {
    assert.match(u, new RegExp(`^${prefix}-mission-b73f0bd2-`));
    assert.doesNotMatch(u, /^timon-mission-/);
  }
});

test("garde-fou désactivé : stopMissionScopes n'exécute aucune commande systemd", async () => {
  // Régression du 29/08/2026 : appelée au boot et sur SIGTERM, cette fonction
  // arrêtait TOUTES les `timon-mission-*.scope` de la machine sans distinction
  // d'instance. Un orchestrateur témoin lancé par un agent tuait donc la scope
  // de cet agent, et les missions de la prod avec. Le garde-fou désactivé doit
  // rendre la fonction totalement inerte — pas même la sonde `hasSystemd()`,
  // qui exécute déjà `systemctl`. On mesure les exécutions réelles du binaire :
  // un retour de 0 ne prouverait rien (c'est aussi "0 scope arrêtée").
  const { invalidateSettingsCache } = await import('./settings.js');
  process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
  invalidateSettingsCache();
  const before = systemctlCallCount();
  assert.equal(stopMissionScopes(), 0);
  assert.equal(systemctlCallCount(), before, 'aucun appel à systemctl ne doit avoir lieu');
  delete process.env.TIMON_RESOURCE_GUARD_ENABLED;
  invalidateSettingsCache();
});

test('deux TIMON_HOME distincts produisent deux préfixes d\'instance distincts', () => {
  const a = instancePrefix('/tmp/timon-home-a');
  const b = instancePrefix('/tmp/timon-home-b');
  assert.match(a, /^timon-[0-9a-f]{8}$/);
  assert.match(b, /^timon-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.equal(grepaiWatcherUnit('demo', '/tmp/timon-home-a').startsWith(`${a}-grepai-watch-`), true);
  assert.equal(missionScopePattern('/tmp/timon-home-a'), `${a}-mission-*.scope`);
});

test("stopMissionScopes du home A ne construit aucune commande au préfixe de B", async () => {
  const { invalidateSettingsCache } = await import('./settings.js');
  const homeA = '/tmp/timon-home-iso-a';
  const homeB = '/tmp/timon-home-iso-b';
  const prefixA = instancePrefix(homeA);
  const prefixB = instancePrefix(homeB);
  const unitA = `${prefixA}-mission-aaaaaaaa-1.scope`;
  const unitB = `${prefixB}-mission-bbbbbbbb-1.scope`;
  const legacy = 'timon-mission-deadbeef-1.scope';
  const calls: string[][] = [];

  process.env.TIMON_RESOURCE_GUARD_ENABLED = '1';
  invalidateSettingsCache();
  setHasSystemdForTest(true);
  setSystemctlForTest((args) => {
    calls.push([...args]);
    if (args[0] === 'list-units') {
      return { ok: true, out: `${unitA} loaded active running\n${unitB} loaded active running\n${legacy} loaded active running\n` };
    }
    return { ok: true, out: '' };
  });
  try {
    const stopped = stopMissionScopes(homeA);
    assert.equal(stopped, 1);
    assert.ok(calls.some((a) => a[0] === 'list-units' && a.includes(missionScopePattern(homeA))));
    const stopCalls = calls.filter((a) => a[0] === 'stop');
    for (const args of stopCalls) {
      assert.ok(args.includes(unitA));
    }
    for (const args of calls) {
      const joined = args.join(' ');
      assert.equal(joined.includes(prefixB), false, `commande au préfixe de B : ${joined}`);
      assert.equal(args.includes(LEGACY_MISSION_SCOPE_PATTERN), false);
      assert.equal(args.includes(unitB), false);
      assert.equal(args.includes(legacy), false);
    }
  } finally {
    setSystemctlForTest(null);
    setHasSystemdForTest(null);
    delete process.env.TIMON_RESOURCE_GUARD_ENABLED;
    invalidateSettingsCache();
  }
});

test("le nom d'unité de prod n'est plus créé ; l'adoption le liste encore", async () => {
  const { invalidateSettingsCache } = await import('./settings.js');
  const home = '/tmp/timon-home-adopt';
  const own = `${instancePrefix(home)}-mission-aaaaaaaa-1.scope`;
  const legacy = 'timon-mission-c0ffee00-1.scope';
  const foreign = `${instancePrefix('/tmp/timon-home-other')}-mission-bbbbbbbb-1.scope`;

  assert.doesNotMatch(missionScopeUnit('c0ffee00-0000-4000-8000-000000000000', home), /^timon-mission-/);
  assert.match(legacy, /^timon-mission-[0-9a-f]{8}-/);

  setHasSystemdForTest(true);
  setSystemctlForTest((args) => {
    const pattern = args[args.length - 1] ?? '';
    if (pattern === missionScopePattern(home)) {
      return { ok: true, out: `${own} loaded active running\n${foreign} loaded active running\n` };
    }
    if (pattern === LEGACY_MISSION_SCOPE_PATTERN) {
      return { ok: true, out: `${legacy} loaded active running\n` };
    }
    return { ok: true, out: '' };
  });
  try {
    const listed = listMissionScopes(home);
    assert.ok(listed.includes(own));
    assert.ok(listed.includes(legacy), 'les scopes historiques restent visibles (adoption en lecture)');
    assert.equal(listed.includes(foreign), false);
  } finally {
    setSystemctlForTest(null);
    setHasSystemdForTest(null);
    delete process.env.TIMON_RESOURCE_GUARD_ENABLED;
    invalidateSettingsCache();
  }
});
