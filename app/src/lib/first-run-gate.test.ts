import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_RUN_PATH, MAIN_AGENT_REPAIR_PATH, WELCOME_PATH, firstRunTarget, schemeFollowsSystem, firstRunScheme } from './first-run-gate';

/**
 * Le parcours réel du 04/09/2026, celui que personne n'avait joué : paquet
 * lancé, compte créé, accueil atteint — et l'écran bloquant de l'étape 5.7.4
 * jamais affiché, donc aucun service installé.
 */
test("le parcours « compte créé → accueil » passe par l'onboarding", () => {
  // 1. Anonyme : on ne détourne pas vers un écran qui a besoin d'une session.
  assert.equal(firstRunTarget({ pathname: '/login', firstRun: true }), null);
  // 2. Compte créé, la page de login renvoie vers l'accueil…
  assert.equal(firstRunTarget({ pathname: '/', firstRun: true }), FIRST_RUN_PATH);
  // 3. …et toute autre page du produit y renvoie aussi.
  for (const page of ['/dashboard', '/missions', '/chat', '/plugins', '/settings/general']) {
    assert.equal(firstRunTarget({ pathname: page, firstRun: true }), FIRST_RUN_PATH);
  }
  // 4. Ni le parcours, ni l'écran de réparation ne se renvoient vers eux-mêmes.
  assert.equal(firstRunTarget({ pathname: '/onboarding', firstRun: true }), null);
  assert.equal(firstRunTarget({ pathname: '/setup', firstRun: true }), null);
});

test('une installation configurée ne voit jamais cet écran', () => {
  for (const page of ['/', '/dashboard', '/setup']) {
    assert.equal(firstRunTarget({ pathname: page, firstRun: false }), null);
  }
});

test("tant que les capacités sont inconnues, on ne détourne rien", () => {
  // Sinon `/setup` clignoterait au démarrage à froid de toute installation.
  assert.equal(firstRunTarget({ pathname: '/', firstRun: undefined }), null);
});

test('les variantes de chemin ne servent pas de contournement', () => {
  assert.equal(firstRunTarget({ pathname: '/dashboard/', firstRun: true }), FIRST_RUN_PATH);
  assert.equal(firstRunTarget({ pathname: '/login/', firstRun: true }), null);
  // Un sous-chemin de /setup reste dans l'onboarding.
  assert.equal(firstRunTarget({ pathname: '/setup/anything', firstRun: true }), null);
  // …mais un chemin qui COMMENCE par les mêmes lettres, non.
  assert.equal(firstRunTarget({ pathname: '/setup-other', firstRun: true }), FIRST_RUN_PATH);
});

/**
 * On redirige avec `replace` : envoyer quelqu'un sur un écran qu'il ne peut pas
 * afficher l'enfermerait sans historique pour revenir. Piéger un utilisateur
 * est pire que le bug que ce garde corrige.
 */
test("un visiteur qui ne peut pas voir /setup n'y est pas envoyé", () => {
  assert.equal(firstRunTarget({ pathname: '/', firstRun: true, canConfigure: false }), null);
  assert.equal(firstRunTarget({ pathname: '/', firstRun: true, canConfigure: true }), FIRST_RUN_PATH);
  // Non renseigné = le cas normal (superadmin de premier lancement, surfaces
  // non restreintes) : on redirige.
  assert.equal(firstRunTarget({ pathname: '/', firstRun: true }), FIRST_RUN_PATH);
});


test('team setup survives configuration and redirects until completed', () => {
  assert.equal(firstRunTarget({ pathname: '/', firstRun: false, teamOnboarding: true }), '/setup/team');
  assert.equal(firstRunTarget({ pathname: '/setup', firstRun: false, teamOnboarding: true }), '/setup/team');
  assert.equal(firstRunTarget({ pathname: '/setup/team', firstRun: false, teamOnboarding: true }), null);
  assert.equal(firstRunTarget({ pathname: '/login', firstRun: false, teamOnboarding: true }), null);
  assert.equal(firstRunTarget({ pathname: '/agents', firstRun: false, teamOnboarding: false }), null);
  assert.equal(firstRunTarget({ pathname: '/agents', firstRun: false, teamOnboarding: true, canConfigure: false }), null);
  assert.equal(firstRunTarget({ pathname: '/agents', firstRun: true, teamOnboarding: true }), FIRST_RUN_PATH);
});

test('until the main agent ends its welcome, every page leads to the TIMs page, where it speaks', () => {
  const pending = { firstRun: false, teamOnboarding: true, mainAgentOnboarding: true };
  assert.equal(WELCOME_PATH, '/bots');
  for (const pathname of ['/', '/agents', '/chat', '/settings', '/setup/team']) {
    assert.equal(firstRunTarget({ pathname, ...pending }), WELCOME_PATH, pathname);
  }
  assert.equal(firstRunTarget({ pathname: '/bots', ...pending }), null, 'the welcome itself');
  assert.equal(firstRunTarget({ pathname: '/bots/', ...pending }), null);
  // `/setup/agent` stays reachable as the repair screen, the onboarding and the login too.
  assert.equal(firstRunTarget({ pathname: '/setup/agent', ...pending }), null);
  assert.equal(firstRunTarget({ pathname: '/onboarding', ...pending }), null);
  assert.equal(firstRunTarget({ pathname: '/login', ...pending }), null);
  // The TIMs page out of reach (module off, a role without the surface): the repair screen hosts the welcome.
  assert.equal(firstRunTarget({ pathname: '/', ...pending, welcomeAvailable: false }), MAIN_AGENT_REPAIR_PATH);
  assert.equal(firstRunTarget({ pathname: '/bots', ...pending, welcomeAvailable: false }), MAIN_AGENT_REPAIR_PATH);
  assert.equal(firstRunTarget({ pathname: '/setup/agent', ...pending, welcomeAvailable: false }), null);
  // A viewer who may not configure is never held.
  assert.equal(firstRunTarget({ pathname: '/', ...pending, canConfigure: false }), null);
  // Answered: the team screen becomes the destination again.
  const answered = { firstRun: false, teamOnboarding: true, mainAgentOnboarding: false };
  assert.equal(firstRunTarget({ pathname: '/setup/agent', ...answered }), '/setup/team');
});

test('a skipped step 3 lets the cockpit open: the gate no longer sends anyone back to /setup/agent', () => {
  // `skipMainAgent` answers step 3 AND closes the team step: both flags drop together.
  const skipped = { firstRun: false, teamOnboarding: false, mainAgentOnboarding: false };
  for (const pathname of ['/', '/agents', '/chat', '/settings']) {
    assert.equal(firstRunTarget({ pathname, ...skipped }), null, pathname);
  }
});

test('onboarding takes its light/dark from the OS, the rest of the product does not', () => {
  for (const path of ['/login', '/login/', '/setup', '/setup/agent', '/setup/team', '/setup/restart']) {
    assert.equal(schemeFollowsSystem(path), true, path);
  }
  for (const path of ['/', '/agents', '/settings', '/setups', '/loginx']) {
    assert.equal(schemeFollowsSystem(path), false, path);
  }
});

test('the restart no longer holds anyone: the banner offers it', () => {
  const pending = { firstRun: false, restartOnboarding: true };
  for (const pathname of ['/', '/agents', '/setup', '/setup/restart']) {
    assert.equal(firstRunTarget({ pathname, ...pending }), null, pathname);
  }
  // The welcome still comes first.
  assert.equal(firstRunTarget({ pathname: '/', ...pending, teamOnboarding: true, mainAgentOnboarding: true }), WELCOME_PATH);
});

test('the onboarding opens light for everyone, whatever the OS, until someone picks', () => {
  const globals = globalThis as { window?: unknown };
  assert.equal(firstRunScheme(), undefined, 'no browser, no scheme');
  for (const light of [true, false]) {
    globals.window = { matchMedia: () => ({ matches: light }), sessionStorage: { getItem: () => null } };
    try { assert.equal(firstRunScheme(), 'light', `OS ${light ? 'light' : 'dark'}: light`); } finally { delete globals.window; }
  }
});
