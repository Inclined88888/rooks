import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_PATHS } from '../../scripts/build-locales.mjs';
import { availableLocales, getLocale, hasKey, isLocaleLoaded, loadLocale, localeDirection, setLocale, t } from './i18n';
import { useSourceLocaleLoader } from './i18n-sources';

useSourceLocaleLoader();

test('collecte les fragments de la locale anglaise', () => {
  setLocale('en');
  assert.equal(t('agentsGrid.gitPush', { count: 2 }), 'git push — 2 commit(s)');
  assert.equal(t('taskForm.create'), 'Create task');
  assert.equal(t('browserPanel.actions.reload'), 'Reload view');
  assert.equal(t('mission.title'), 'New mission');
  assert.equal(t('loginPage.title'), 'Sign in');
  assert.equal(t('session.logout'), 'Sign out');
  assert.equal(t('cockpit.accountUsage.disconnected'), 'Not signed in');
});

test('le français ne s\'active qu\'une fois chargé', async () => {
  setLocale('en');
  setLocale('fr');
  assert.equal(getLocale(), 'en', 'pas encore chargé : on reste en anglais');
  await loadLocale('fr');
  assert.equal(getLocale(), 'fr');
  setLocale('en');
});

test('collecte les fragments de la locale française', async () => {
  await loadLocale('fr');
  assert.equal(t('projectsPage.projectCount', { count: 2 }), '2 projet(s)');
  assert.equal(t('taskForm.create'), 'Créer la tâche');
  assert.equal(t('browserPanel.actions.reload'), 'Recharger la vue');
  assert.equal(t('mission.title'), 'Nouvelle mission');
  assert.equal(t('loginPage.title'), 'Connexion');
  assert.equal(t('session.logout'), 'Se déconnecter');
  assert.equal(t('cockpit.accountUsage.disconnected'), 'Non connecté');
  setLocale('en');
});

test('a key nobody has reads as itself; a language absent from the catalog loads nothing', async () => {
  setLocale('en');
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.equal(hasKey('no.such.key'), false);
  assert.equal(hasKey('taskForm.create'), true);
  await loadLocale('xx');
  assert.equal(getLocale(), 'en');
  assert.equal(isLocaleLoaded('xx'), false);
});

test('the catalog lists the languages present, each in its own name', () => {
  const tags = availableLocales().map((info) => info.tag);
  assert.ok(tags.includes('en') && tags.includes('fr'), tags.join(', '));
  assert.equal(availableLocales().find((info) => info.tag === 'fr')?.name, 'Français');
  assert.equal(localeDirection('fr'), 'ltr');
});

/**
 * A language added by a folder alone: English plus a partial Polish, read
 * through the same loader as the product's. The real English sources come
 * along, since English is the bundled source language.
 */
test('a language added by a single folder is discovered, loaded, pluralised and falls back to English key by key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'locales-pl-'));
  cpSync(join(DEFAULT_PATHS.sourceDir, 'en'), join(root, 'en'), { recursive: true });
  mkdirSync(join(root, 'pl'));
  writeFileSync(join(root, 'pl', 'meta.json'), JSON.stringify({ name: 'Polski', dir: 'ltr' }));
  writeFileSync(join(root, 'pl', 'cockpit.json'), JSON.stringify({
    cockpit: {
      dreams: { pending: '{count, plural, one {# oczekujący} few {# oczekujące} many {# oczekujących} other {# oczekującego}}' },
    },
  }));
  try {
    useSourceLocaleLoader(root);
    assert.equal(availableLocales().find((info) => info.tag === 'pl')?.name, 'Polski');
    await loadLocale('pl');
    assert.equal(getLocale(), 'pl');
    assert.equal(t('cockpit.dreams.pending', { count: 1 }), '1 oczekujący');
    assert.equal(t('cockpit.dreams.pending', { count: 2 }), '2 oczekujące');
    assert.equal(t('cockpit.dreams.pending', { count: 5 }), '5 oczekujących');
    assert.equal(t('cockpit.dreams.pending', { count: 22 }), '22 oczekujące');
    assert.equal(t('taskForm.create'), 'Create task', 'a key Polish lacks reads in English');
  } finally {
    setLocale('en');
    useSourceLocaleLoader();
  }
});
