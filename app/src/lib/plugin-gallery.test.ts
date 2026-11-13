/**
 * Ce que la galerie locale promet, et que rien d'autre ne vérifie : une carte
 * est dessinée pour un plugin DÉBRANCHÉ comme pour un plugin actif, et le
 * toggle ne ment pas sur un plugin que le daemon refuse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GALLERY_PROVENANCES,
  GALLERY_TYPES,
  containedEntries, countByProvenance, coverProxyUrl, filterGallery, groupBySource, iconProxyUrl, kindLabel,
  mediaSlides, stillProxyUrl,
  provenanceOf, sortForGallery, toCardData, type PluginPublic,
} from './plugin-gallery';
import { pictoSrc } from './picto';
import { getLocale, setLocale } from './i18n';
import './i18n-test-locales';

function plugin(patch: Partial<PluginPublic>): PluginPublic {
  return {
    id: 'acme', pkg: '@acme/plugin', version: '1.0.0', source: 'third-party', tier: null, wanted: null,
    state: 'active', reason: null, error: null,
    kind: ['widget'], label: 'Acme', description: null, author: 'Acme Corp', signed: true, screenshots: [],
    cover: null, slots: ['cockpit.widget'],
    route: null, declares: {}, modifies: [], contains: [], client: null, settings: [],
    ...patch,
  };
}

test('island plugins have a translated kind and can be filtered in the gallery', () => {
  const locale = getLocale();
  try {
    setLocale('en');
    assert.equal(kindLabel('island'), 'Island');
    setLocale('fr');
    assert.equal(kindLabel('island'), 'Îlot');
    const island = plugin({ id: 'example-island', kind: ['island'], slots: ['island.content'] });
    assert.ok(GALLERY_TYPES.includes('island'));
    assert.deepEqual(filterGallery([plugin({}), island], { provenance: 'all', type: 'island', query: '' }), [island]);
  } finally {
    setLocale(locale);
  }
});

test('un plugin débranché garde sa carte : cover, slots et titre viennent du manifeste', () => {
  const card = toCardData(plugin({
    state: 'disabled',
    reason: 'disabled in rooks.config.json',
    cover: '/plugins/acme/cover?rev=abc',
  }));
  assert.equal(card.enabled, false);
  assert.equal(card.blockedReason, null, 'débrancher n\'est pas un refus : le toggle reste actionnable');
  assert.equal(card.coverUrl, '/api/ui/plugin-covers/acme?rev=abc');
  assert.deepEqual(card.slots, ['cockpit.widget']);
});

test('un refus du daemon grise le toggle et affiche sa raison', () => {
  for (const state of ['skipped', 'failed'] as const) {
    const card = toCardData(plugin({ state, reason: `skipped:unsigned`, error: 'SIGNATURE absent' }));
    assert.equal(card.blockedReason, 'SIGNATURE absent', state);
    // Et le switch est ÉTEINT. Il est grisé par `blockedReason`, donc
    // personne ne peut le basculer : allumé, il affirmait simplement que le
    // plugin tourne alors que le daemon l'a refusé.
    assert.equal(card.enabled, false, state);
  }
  assert.equal(toCardData(plugin({ state: 'skipped', reason: 'skipped:unlicensed', error: null })).blockedReason, 'skipped:unlicensed');
});

test('le label retombe sur l\'id, jamais sur du vide', () => {
  assert.equal(toCardData(plugin({ label: null })).label, 'acme');
});

test('la route d\'une page est affichée à côté de ses slots', () => {
  const card = toCardData(plugin({ kind: ['page'], slots: ['page'], route: '/acme' }));
  assert.equal(card.route, '/acme');
  assert.deepEqual(card.kinds, ['page']);
});

test('coverProxyUrl passe par le proxy Next et garde la révision', () => {
  assert.equal(coverProxyUrl('acme', null), null);
  assert.equal(coverProxyUrl('acme', '/plugins/acme/cover'), '/api/ui/plugin-covers/acme');
  assert.equal(coverProxyUrl('a b', '/plugins/x/cover?rev=1'), '/api/ui/plugin-covers/a%20b?rev=1');
  assert.equal(stillProxyUrl('acme', '/plugins/acme/still/0?rev=ab'), '/api/ui/plugin-stills/acme/0?rev=ab');
});

test('l\'ordre de la galerie : branchés, refusés, débranchés', () => {
  const order = sortForGallery([
    plugin({ id: 'off', label: 'Off', state: 'disabled' }),
    plugin({ id: 'ko', label: 'Ko', state: 'failed' }),
    plugin({ id: 'on', label: 'On', state: 'active' }),
  ]).map((p) => p.id);
  assert.deepEqual(order, ['on', 'ko', 'off']);
});

function bundled(patch: Partial<PluginPublic>): PluginPublic {
  return plugin({
    id: '@rooks/vault', pkg: '@rooks/vault', version: '', source: 'bundled', tier: 'opt', wanted: 'auto',
    kind: ['widget'], label: null, slots: ['cockpit.widget'], author: 'Rooks', signed: null,
    ...patch,
  });
}

/**
 * Le bug qui a ouvert ce volet : `/plugins` disait « aucun plugin » sur une
 * installation qui embarque une trentaine de modules.
 */
test('les modules du produit forment leur propre moitié de galerie', () => {
  const { bundled: mine, thirdParty } = groupBySource([bundled({}), plugin({})]);
  assert.deepEqual(mine.map((p) => p.id), ['@rooks/vault']);
  assert.deepEqual(thirdParty.map((p) => p.id), ['acme']);
  const card = toCardData(bundled({}));
  assert.equal(card.label, 'Vault');
  assert.match(card.description ?? '', /cockpit/);
  assert.equal(card.author, 'Rooks');
  assert.deepEqual(card.kinds, ['widget']);
  assert.equal(card.version, null);
});

test('behavior s\'affiche Backend, les autres kinds gardent un libellé lisible', () => {
  assert.equal(kindLabel('behavior'), 'Backend');
  assert.equal(kindLabel('widget'), 'Widget');
  assert.equal(kindLabel('page'), 'Page');
  assert.equal(kindLabel('bundle'), 'Bundle');
  assert.equal(kindLabel('layout'), 'Layout');
});

test('un bundled éteint ne parle jamais de redémarrage', () => {
  // L'état nominal après une bascule : le daemon a recomposé l'arbre pendant
  // la requête, donc la config et l'arbre disent la même chose.
  const off = toCardData(bundled({ wanted: false, state: 'disabled' }));
  assert.equal(off.enabled, false);
  assert.equal(off.note, null, 'plus rien à attendre : la bascule a déjà eu lieu');
  assert.equal(off.blockedReason, null);

  // La fenêtre d'avant, où la config disait non et le module tournait encore.
  // Elle ne doit plus exister ; si elle se rouvre, on ne renvoie personne vers
  // un redémarrage que seul l'utilisateur peut faire.
  const stale = toCardData(bundled({ wanted: false, state: 'active' }));
  assert.equal(stale.enabled, false);
  assert.equal(stale.note, null);

  // `auto` : le switch montre ce que le noyau a décidé.
  assert.equal(toCardData(bundled({ wanted: 'auto', state: 'active' })).enabled, true);
  assert.equal(toCardData(bundled({ wanted: 'auto', state: 'disabled' })).enabled, false);
});

test('une capacité hôte absente explique sans confisquer le toggle', () => {
  const card = toCardData(bundled({
    id: 'grepai', tier: 'dev', wanted: 'auto', state: 'skipped',
    reason: 'capacité hôte absente : grepai',
  }));
  assert.equal(card.blockedReason, null, 'std/opt/dev restent basculables');
  assert.equal(card.locked, false);
  assert.equal(card.note, 'capacité hôte absente : grepai');
});

test('a bundled module the licence leaves out reads as refused, not as turned on', () => {
  // Machines enabled in the config, skipped by the daemon: the switch lit on
  // the wish told the user it ran, and nothing on screen said otherwise.
  for (const reason of ['non couvert par la licence', 'not included in this licence']) {
    const card = toCardData(bundled({ id: '@rooks/machines', tier: 'opt', wanted: true, state: 'skipped', reason }));
    assert.equal(card.enabled, false);
    assert.equal(card.blockedReason, 'Not included in your licence');
    assert.equal(card.note, null, 'the raw sentence of the daemon is not repeated under it');
    assert.equal(card.locked, false);
  }
  // Off by default and not licensed: same card.
  const auto = toCardData(bundled({ id: '@rooks/dreams', tier: 'std', wanted: 'auto', state: 'skipped', reason: 'non couvert par la licence' }));
  assert.equal(auto.blockedReason, 'Not included in your licence');
  // A licensed module that runs is untouched.
  assert.equal(toCardData(bundled({ id: '@rooks/dreams', tier: 'std', wanted: true, state: 'active' })).blockedReason, null);
});

test('un module core est visible, mais son toggle est confisqué', () => {
  const card = toCardData(bundled({ id: '@rooks/db', tier: 'core', state: 'active' }));
  assert.equal(card.locked, true);
  assert.equal(card.enabled, true);
  assert.equal(card.note, 'Core module — the daemon does not run without it.');
  // Un `false` écrit à la main dans le fichier ne peut pas éteindre le noyau :
  // le switch montre ce qui tourne, pas un souhait que `planEntries` ignore.
  assert.equal(toCardData(bundled({ id: '@rooks/db', tier: 'core', state: 'active', wanted: false })).enabled, true);
});

test('le thème produit est verrouillé sans être core : il porte la palette', () => {
  // `std` : le daemon n'en a pas besoin, le navigateur si. L'éteindre viderait
  // le slot `theme` — 125 tokens indéfinis, galerie comprise. Le daemon refuse
  // (403), donc l'interrupteur ne doit même pas être proposé.
  const card = toCardData(bundled({ id: '@rooks/ui-theme', tier: 'std', state: 'active' }));
  assert.equal(card.locked, true);
  assert.equal(card.note, 'Carries every colour token — switching it off would leave the app with no palette. Change theme in Appearance.');
  assert.equal(toCardData(bundled({ id: '@rooks/vault', tier: 'std', state: 'active' })).locked, false);
});

test('deux familles : @rooks (au scope de l\'id) et Marketplace', () => {
  // Le tier ne fabrique plus de famille : un module `core` est un @rooks comme
  // les autres, il ne s'en distingue que par son interrupteur confisqué.
  assert.equal(provenanceOf(bundled({ id: '@rooks/db', tier: 'core' })), 'rooks');
  assert.equal(provenanceOf(bundled({ id: '@rooks/vault', tier: 'opt' })), 'rooks');
  // La signature ne classe plus : un paquet tiers approuvé reste au Marketplace,
  // avec un badge « Verified » sur sa carte.
  assert.equal(provenanceOf(plugin({ signed: true })), 'marketplace');
  assert.equal(provenanceOf(plugin({ signed: false, state: 'skipped', reason: 'skipped:unsigned' })), 'marketplace');
  assert.deepEqual([...GALLERY_PROVENANCES], ['rooks', 'marketplace']);
});

test('le badge de la carte suit la signature, et seul un tiers en porte un', () => {
  assert.equal(toCardData(plugin({ signed: true })).signed, true);
  assert.equal(toCardData(plugin({ signed: false })).signed, false);
  assert.equal(toCardData(bundled({ id: '@rooks/db', tier: 'core' })).signed, null);
});

test('filtre galerie : provenance, type et recherche se composent', () => {
  const catalog = [
    bundled({ id: '@rooks/db', tier: 'core', kind: ['behavior'], label: null }),
    bundled({ id: '@rooks/vault', tier: 'opt', kind: ['widget'] }),
    plugin({ id: 'acme', signed: true, kind: ['widget'], label: 'Acme' }),
    plugin({ id: 'example-bundle', signed: false, kind: ['bundle'], label: 'Tableau exemple' }),
  ];
  const all = { provenance: 'all' as const, type: 'all' as const, query: '' };
  assert.equal(filterGallery(catalog, all).length, 4);
  assert.deepEqual(
    filterGallery(catalog, { ...all, provenance: 'rooks' }).map((p) => p.id).sort(),
    ['@rooks/db', '@rooks/vault'],
  );
  assert.deepEqual(
    filterGallery(catalog, { ...all, provenance: 'marketplace' }).map((p) => p.id).sort(),
    ['acme', 'example-bundle'],
  );
  assert.deepEqual(
    filterGallery(catalog, { ...all, type: 'widget' }).map((p) => p.id).sort(),
    ['@rooks/vault', 'acme'],
  );
  assert.deepEqual(
    filterGallery(catalog, { ...all, query: 'tableau' }).map((p) => p.id),
    ['example-bundle'],
  );
  const counts = countByProvenance(catalog, { type: 'all', query: '' });
  assert.equal(counts.all, 4);
  assert.equal(counts.rooks, 2);
  assert.equal(counts.marketplace, 2);
});

test('un bundle résout ses enfants dans le catalogue, et nomme ceux qui manquent', () => {
  const page = plugin({ id: 'example-page', kind: ['page'], label: 'Page d\'exemple' });
  const pack = plugin({ id: 'example-bundle', kind: ['bundle'], contains: ['example-page', 'example-widget'] });
  const entries = containedEntries(pack.contains, [pack, page]);
  assert.equal(entries[0]?.plugin?.id, 'example-page');
  assert.equal(entries[1]?.plugin, null);
  assert.equal(entries[1]?.id, 'example-widget');
});

test('mediaSlides pose la cover en premier et déduplique les stills', () => {
  assert.deepEqual(mediaSlides({ coverUrl: null, screenshots: [] }), []);
  assert.deepEqual(mediaSlides({ coverUrl: '/a.png', screenshots: ['/a.png', '/b.png'] }), ['/a.png', '/b.png']);
});

test('a built-in reads as ours: flagged on the card, filed under Rooks, toggle kept', () => {
  const builtin = plugin({ id: 'quota-monitor', pkg: '@rooks/plugin-quota-monitor', signed: false, builtin: true, state: 'disabled' });
  const card = toCardData(builtin);
  assert.equal(card.builtin, true);
  assert.equal(card.enabled, false);
  assert.equal(card.blockedReason, null, 'disabling a built-in is the user\'s gesture, not a refusal');
  assert.equal(provenanceOf(builtin), 'rooks');
  assert.equal(toCardData(plugin({})).builtin, false);
  assert.equal(provenanceOf(plugin({})), 'marketplace');
});

test('iconProxyUrl: a bundled data URL passes, a package picto goes through the proxy, anything else is dropped', () => {
  const data = 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E';
  assert.equal(iconProxyUrl('@rooks/vault', data), data);
  assert.equal(iconProxyUrl('acme', '/plugins/acme/icon?rev=abc'), '/api/ui/plugin-icons/acme?rev=abc');
  assert.equal(iconProxyUrl('acme', 'https://tracker.test/icon.svg'), null);
  assert.equal(iconProxyUrl('acme', 'data:text/html,<script>'), null);
  assert.equal(iconProxyUrl('acme', null), null);
  assert.equal(iconProxyUrl('acme', undefined), null);
});

test('pictoSrc: markup becomes a data URL, a URL stays one', () => {
  assert.equal(pictoSrc(' <svg/> '), `data:image/svg+xml,${encodeURIComponent('<svg/>')}`);
  assert.equal(pictoSrc('/x/icon.svg'), '/x/icon.svg');
});

test('a running module that lost part of itself to the host says so, switch untouched (TODO #275)', () => {
  const card = toCardData(bundled({
    id: '@rooks/kanban', tier: 'std', wanted: 'auto', state: 'active',
    warning: 'git not found on this host: code, review and merge tasks of a git project are refused',
  }));
  assert.equal(card.enabled, true);
  assert.equal(card.blockedReason, null);
  assert.equal(card.note, 'git not found on this host: code, review and merge tasks of a git project are refused');
  assert.equal(toCardData(bundled({ id: '@rooks/kanban', tier: 'std', wanted: 'auto', state: 'active' })).note, null);
});

test('the Files card plugin carries the widget badge in the gallery (TODO #356)', async () => {
  const { KIND_TONE } = await import('../components/plugin-kind-badge');
  const card = toCardData(plugin({
    id: '@rooks/files-widget', pkg: '@rooks/files-widget', source: 'bundled', tier: 'std', signed: null,
    kind: ['widget'], slots: ['chat.left.widget'], label: null, author: 'Rooks',
  }));
  assert.deepEqual(card.kinds, ['widget']);
  assert.ok(KIND_TONE.widget, 'the widget badge has its tone');
  assert.equal(kindLabel('widget'), kindLabel(card.kinds[0]!));
});

test('the Skills and MCP card plugins carry the widget badge in the gallery (TODO #357)', () => {
  for (const id of ['@rooks/skills-widget', '@rooks/mcp-widget']) {
    const card = toCardData(plugin({
      id, pkg: id, source: 'bundled', tier: 'std', signed: null,
      kind: ['widget'], slots: ['chat.right.widget'], label: null, author: 'Rooks',
    }));
    assert.deepEqual(card.kinds, ['widget'], id);
  }
});

test('a dictation plugin\'s card says where its voice goes, from the manifest the daemon read', () => {
  const locale = getLocale();
  try {
    setLocale('en');
    // Another kind carrying a dictation block (impossible after admission) says nothing.
    assert.deepEqual(toCardData(plugin({ dictation: { engines: [{ id: 'x1', runtime: 'page', egress: 'none' }] } })).voice, []);
    // An egress out of shape is not rendered as a destination.
    const forged = plugin({ kind: ['dictation'], dictation: { engines: [{ id: 'acme', runtime: 'page', egress: ['https://evil'] }], models: null } });
    assert.deepEqual(toCardData(forged).voice, []);
    const cloud = plugin({ kind: ['dictation'], dictation: { engines: [{ id: 'acme', runtime: 'page', egress: ['api.acme.com'] }], models: null } });
    assert.deepEqual(toCardData(cloud).voice, ['Your voice is sent to api.acme.com.']);
    assert.equal(kindLabel('dictation'), 'Dictation');
    assert.ok(GALLERY_TYPES.includes('dictation'));
    setLocale('fr');
    const daemon = plugin({ kind: ['dictation'], dictation: { engines: [{ id: 'acme', runtime: 'daemon', egress: 'daemon' }], models: null } });
    assert.deepEqual(toCardData(daemon).voice, ['Votre voix est envoyée au daemon Rooks de la machine active.']);
  } finally {
    setLocale(locale);
  }
});
