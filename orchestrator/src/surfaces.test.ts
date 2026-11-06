/**
 * M.4 — surface permissions: wildcards reused from M.2, deny by default,
 * superadmin sees everything, empty viewer stays historical.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginPublic } from './plugins/public.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-surfaces-m4-'));

const {
  attachSurfaces,
  filterGallery,
  pluginVisible,
  resolveChromeChoice,
  shortPluginId,
  surfacesForViewer,
  thirdPartyAssetVisible,
  thirdPartyPluginVisible,
  viewerAllows,
  viewerMayChooseChrome,
  viewerSurfacesUnrestricted,
} = await import('./users/surfaces.js');
const { SETUP_ROLE_PRESETS } = await import('../tests/helpers/presets.js');

const employee = SETUP_ROLE_PRESETS.find((p) => p.key === 'employee')!.permissions;
const admin = SETUP_ROLE_PRESETS.find((p) => p.key === 'administration')!.permissions;

const ada = { id: 'ada', isSuperadmin: false, permissions: employee };
const rom = { id: 'rom', isSuperadmin: true, permissions: [] };
const boss = { id: 'boss', isSuperadmin: false, permissions: admin };

function plugin(over: Partial<PluginPublic> & Pick<PluginPublic, 'id'>): PluginPublic {
  return {
    pkg: over.id,
    version: '',
    source: 'third-party',
    tier: null,
    wanted: null,
    kind: ['widget'],
    label: null,
    description: null,
    signed: true,
    author: null,
    screenshots: [],
    cover: null,
    slots: ['cockpit.widget'],
    route: null,
    declares: {},
    modifies: [],
    contains: [],
    state: 'active',
    reason: null,
    error: null,
    client: { url: `/plugins/${over.id}/client.js`, rev: 'abc', slots: ['cockpit.widget'] },
    settings: [],
    ...over,
  };
}

const kanban: PluginPublic = plugin({
  id: '@timon/kanban',
  source: 'bundled',
  kind: ['page'],
  slots: ['nav.item'],
  route: '/kanban',
  client: null,
  signed: null,
});
const agenda: PluginPublic = plugin({
  id: '@timon/agenda',
  source: 'bundled',
  kind: ['widget'],
  slots: ['cockpit.widget'],
  client: null,
  signed: null,
});
const acme = plugin({ id: 'acme-crm', kind: ['page'], route: '/acme', slots: ['nav.item'] });

test('short id of a bundled module is the last path segment', () => {
  assert.equal(shortPluginId('@timon/agenda'), 'agenda');
  assert.equal(shortPluginId('acme-crm'), 'acme-crm');
});

test('no viewer and superadmin are unrestricted; employee is not', () => {
  assert.equal(viewerSurfacesUnrestricted(null), true);
  assert.equal(viewerSurfacesUnrestricted(rom), true);
  assert.equal(viewerSurfacesUnrestricted(boss), true, 'Administration grant of `*` is unrestricted');
  assert.equal(viewerSurfacesUnrestricted(ada), false);
});

test('employee preset sees home and chat, nothing else', () => {
  assert.equal(viewerAllows(ada, 'page:/'), true);
  assert.equal(viewerAllows(ada, 'page:/chat'), true);
  assert.equal(viewerAllows(ada, 'layout:ui-layout'), true);
  assert.equal(viewerAllows(ada, 'theme:ui-theme'), true);
  assert.equal(viewerAllows(ada, 'page:/kanban'), false);
  assert.equal(viewerAllows(ada, 'page:/settings'), false);
  assert.equal(viewerAllows(ada, 'widget:agenda'), false);
  assert.equal(viewerAllows(ada, 'plugin:acme-crm'), false);
  assert.equal(viewerAllows(ada, 'nav:projects'), false);
});

test('superadmin and Administration see every surface', () => {
  assert.equal(viewerAllows(rom, 'page:/settings'), true);
  assert.equal(viewerAllows(rom, 'plugin:acme-crm'), true);
  assert.equal(viewerAllows(boss, 'page:/settings'), true);
  assert.equal(viewerAllows(boss, 'widget:agenda'), true);
  assert.equal(viewerAllows(boss, 'plugin:acme-crm'), true);
});

test('a freshly installed third-party plugin is invisible without plugin:<id>', () => {
  assert.equal(pluginVisible(acme, ada), false);
  assert.equal(pluginVisible(acme, rom), true);
  assert.equal(thirdPartyPluginVisible(ada, 'acme-crm'), false);
  assert.equal(thirdPartyPluginVisible(rom, 'acme-crm'), true);
  const granted = { ...ada, permissions: [...employee, 'plugin:acme-crm'] };
  assert.equal(pluginVisible(acme, granted), true);
  assert.equal(pluginVisible(plugin({ id: 'other-crm' }), granted), false);
});

test('bundled pages and widgets open with their own surface grant', () => {
  assert.equal(pluginVisible(kanban, ada), false);
  assert.equal(pluginVisible(agenda, ada), false);
  const withKanban = { ...ada, permissions: [...employee, 'page:/kanban'] };
  assert.equal(pluginVisible(kanban, withKanban), true);
  assert.equal(pluginVisible(agenda, withKanban), false);
  const withAgenda = { ...ada, permissions: [...employee, 'widget:agenda'] };
  assert.equal(pluginVisible(agenda, withAgenda), true);
});

/**
 * TODO #356: the chat's Files card is its own plugin, so a role written for
 * the agents' cards does not open it, and its own grant opens nothing else.
 * Built from the real gallery identity, which is what the daemon serves.
 */
test('widget:files-widget opens the Files card; widget:agents no longer does', async () => {
  const { toPublicBundled } = await import('./plugins/public.js');
  const row = (id: string) => ({ id, tier: 'std' as const, active: true, reason: null, missing: [], wanted: 'auto' as const });
  const files = toPublicBundled(row('@timon/files-widget'));
  const agents = toPublicBundled({ ...row('@timon/agents'), tier: 'core' });
  const gallery = [agents, files];
  const seen = (permissions: string[]) => surfacesForViewer({ ...ada, permissions: [...employee, ...permissions] }, gallery);

  const employeeView = surfacesForViewer(ada, gallery);
  assert.ok(!('all' in employeeView && employeeView.all));
  assert.equal(pluginVisible(files, ada), false, 'deny by default: the Employee preset carries no widget grant');

  const withAgents = seen(['widget:agents']);
  assert.ok('widgets' in withAgents);
  assert.deepEqual(withAgents.widgets, ['agents']);
  assert.equal(withAgents.plugins.includes('@timon/files-widget'), false);

  const withFiles = seen(['widget:files-widget']);
  assert.ok('widgets' in withFiles);
  assert.deepEqual(withFiles.widgets, ['files-widget']);
  assert.deepEqual(withFiles.plugins, ['@timon/files-widget']);
});

/** TODO #357: same split for the Skills and MCP cards of the right rail. */
test('widget:skills-widget and widget:mcp-widget open their card only; widget:agents opens neither', async () => {
  const { toPublicBundled } = await import('./plugins/public.js');
  const row = (id: string) => ({ id, tier: 'std' as const, active: true, reason: null, missing: [], wanted: 'auto' as const });
  const skills = toPublicBundled(row('@timon/skills-widget'));
  const mcp = toPublicBundled(row('@timon/mcp-widget'));
  const agents = toPublicBundled({ ...row('@timon/agents'), tier: 'core' });
  const gallery = [agents, skills, mcp];
  const seen = (permissions: string[]) => surfacesForViewer({ ...ada, permissions: [...employee, ...permissions] }, gallery);

  assert.equal(pluginVisible(skills, ada), false, 'deny by default');
  assert.equal(pluginVisible(mcp, ada), false, 'deny by default');

  const withAgents = seen(['widget:agents']);
  assert.ok('plugins' in withAgents);
  assert.deepEqual(withAgents.plugins.filter((id) => id !== '@timon/agents'), []);

  const withSkills = seen(['widget:skills-widget']);
  assert.ok('widgets' in withSkills);
  assert.deepEqual(withSkills.widgets, ['skills-widget']);
  assert.deepEqual(withSkills.plugins, ['@timon/skills-widget']);

  const withMcp = seen(['widget:mcp-widget']);
  assert.ok('widgets' in withMcp);
  assert.deepEqual(withMcp.widgets, ['mcp-widget']);
  assert.deepEqual(withMcp.plugins, ['@timon/mcp-widget']);
});

/** TODO #645: each remaining card of the chat's rails has a grant the role editor can offer. */
test('every card of the chat rails is opened by its own widget grant, not by the page of its module', async () => {
  const { toPublicBundled } = await import('./plugins/public.js');
  const row = (id: string) => ({ id, tier: 'std' as const, active: true, reason: null, missing: [], wanted: 'auto' as const });
  const modules = ['@timon/missions', '@timon/workflows', '@timon/git', '@timon/grepai', '@timon/docker-supervision', '@timon/orchestrator-self', '@timon/video-factory'];
  const gallery = modules.map((id) => toPublicBundled(row(id)));
  for (const id of modules) {
    const short = id.slice('@timon/'.length);
    const view = surfacesForViewer({ ...ada, permissions: ['page:/chat', `widget:${short}`] }, gallery);
    assert.ok('widgets' in view);
    assert.deepEqual(view.widgets, [short], id);
    assert.deepEqual(view.plugins, [id], id);
    assert.deepEqual(view.pages, ['/chat'], `${id}: the card does not open a page`);
  }
});

test('filterGallery drops hidden plugins and keeps the rest', () => {
  const all = [kanban, agenda, acme];
  assert.deepEqual(filterGallery(all, rom).map((p) => p.id), ['@timon/kanban', '@timon/agenda', 'acme-crm']);
  assert.deepEqual(filterGallery(all, ada).map((p) => p.id), []);
  const withKanban = { ...ada, permissions: [...employee, 'page:/kanban'] };
  assert.deepEqual(filterGallery(all, withKanban).map((p) => p.id), ['@timon/kanban']);
});

test('surfacesForViewer lists only granted pages for the employee', () => {
  const view = surfacesForViewer(ada, [kanban, agenda, acme]);
  assert.equal('all' in view && view.all === true, false);
  if ('pages' in view) {
    assert.deepEqual(view.pages, ['/', '/chat']);
    assert.equal(view.pages.includes('/kanban'), false);
    assert.equal(view.pages.includes('/settings'), false);
    assert.equal(view.pages.includes('/acme'), false);
    assert.deepEqual(view.widgets, []);
    assert.deepEqual(view.plugins, []);
  }
});

test('surfacesForViewer is `{ all: true }` for superadmin and first-run', () => {
  assert.deepEqual(surfacesForViewer(null, [acme]), { all: true });
  assert.deepEqual(surfacesForViewer(rom, [acme]), { all: true });
  assert.deepEqual(surfacesForViewer(boss, [acme]), { all: true });
});

const uiLayout: PluginPublic = plugin({
  id: '@timon/ui-layout',
  source: 'bundled',
  kind: ['layout'],
  slots: ['root'],
  client: null,
  signed: null,
});
const blankLayout = plugin({ id: 'blank-layout', kind: ['layout'], slots: ['root'] });

test('employee seed opens the product chrome; a role without layout:ui-layout does not', () => {
  assert.equal(pluginVisible(uiLayout, ada), true);
  assert.equal(pluginVisible(uiLayout, rom), true);
  const withoutChrome = {
    ...ada,
    permissions: employee.filter((p) => p !== 'layout:ui-layout'),
  };
  assert.equal(pluginVisible(uiLayout, withoutChrome), false);
  const view = surfacesForViewer(ada, [uiLayout, kanban, agenda]);
  assert.equal('all' in view && view.all === true, false);
  if ('layouts' in view) {
    assert.deepEqual(view.layouts, ['ui-layout']);
    assert.deepEqual(view.plugins, ['@timon/ui-layout']);
    assert.deepEqual(view.themes, []);
  }
  const stripped = surfacesForViewer(withoutChrome, [uiLayout]);
  if ('layouts' in stripped) {
    assert.deepEqual(stripped.layouts, []);
    assert.deepEqual(stripped.plugins, []);
  }
});

test('a third-party layout opens with layout:<short> alone, client half included', () => {
  assert.equal(pluginVisible(blankLayout, ada), false);
  assert.equal(pluginVisible(blankLayout, rom), true);
  const withShort = { ...ada, permissions: [...employee, 'layout:blank-layout'] };
  assert.equal(pluginVisible(blankLayout, withShort), true);
  // The gallery, the surface list and the asset route must agree: a layout
  // advertised but whose client.js 404s would leave an empty `root` slot.
  assert.equal(thirdPartyAssetVisible(withShort, 'blank-layout', blankLayout.kind), true);
  const view = surfacesForViewer(withShort, [blankLayout]);
  if ('layouts' in view) {
    assert.deepEqual(view.layouts, ['blank-layout']);
    assert.deepEqual(view.plugins, ['blank-layout']);
  }
  // The grant names one layout, not the gallery: a neighbour package stays shut.
  assert.equal(pluginVisible(acme, withShort), false);
  assert.equal(thirdPartyPluginVisible(withShort, 'acme-crm'), false);
  assert.equal(thirdPartyAssetVisible(withShort, 'acme-crm', acme.kind), false);
});

test('layout:<id> on a package that is not a layout opens nothing', () => {
  // A role can carry a permission string the catalogue never minted — it only
  // mints `layout:<short>` for a `kind: layout` plugin, but a role editor takes
  // free text. The curtain must therefore read the RESOLVED identity, not the
  // permission: otherwise `layout:acme-crm` would serve the browser half of a
  // widget package that no role was ever meant to see.
  const forged = { ...ada, permissions: [...employee, 'layout:acme-crm', 'layout:acme-job'] };
  assert.equal(pluginVisible(acme, forged), false, 'gallery');
  assert.equal(thirdPartyAssetVisible(forged, 'acme-crm', acme.kind), false, 'bundle + cover');
  assert.equal(thirdPartyPluginVisible(forged, 'acme-crm'), false, 'API router');

  const job = plugin({ id: 'acme-job', kind: ['behavior'], slots: [], client: null });
  assert.equal(pluginVisible(job, forged), false);
  assert.equal(thirdPartyAssetVisible(forged, 'acme-job', job.kind), false);
  assert.equal(thirdPartyPluginVisible(forged, 'acme-job'), false);

  const view = surfacesForViewer(forged, [acme, job]);
  if ('layouts' in view) {
    assert.deepEqual(view.layouts, []);
    assert.deepEqual(view.plugins, []);
  }
  // An id the loader does not resolve yields no kind — strict, never a grant.
  assert.equal(thirdPartyAssetVisible(forged, 'acme-crm', []), false);
});

test('a layout+behavior package: layout:<short> paints the chrome, plugin:<id> opens its API', () => {
  // `behavior` is the half with a host `ctx.router`. Wearing someone's chrome
  // must not hand over their API — the two curtains are separate on purpose.
  const hybrid = plugin({
    id: 'hybrid-behavior',
    kind: ['layout', 'behavior'],
    slots: ['root'],
  });
  const withShort = { ...ada, permissions: [...employee, 'layout:hybrid-behavior'] };
  assert.equal(pluginVisible(hybrid, withShort), true, 'gallery: it is a layout');
  assert.equal(thirdPartyAssetVisible(withShort, hybrid.id, hybrid.kind), true, 'client.js + cover');
  assert.equal(thirdPartyPluginVisible(withShort, hybrid.id), false, 'API stays behind plugin:<id>');
  const view = surfacesForViewer(withShort, [hybrid]);
  if ('layouts' in view) assert.deepEqual(view.layouts, ['hybrid-behavior']);

  const whole = { ...ada, permissions: [...employee, 'plugin:hybrid-behavior'] };
  assert.equal(thirdPartyPluginVisible(whole, hybrid.id), true);
  assert.equal(thirdPartyAssetVisible(whole, hybrid.id, hybrid.kind), true);

  // Unrestricted viewers keep everything, kind or not.
  assert.equal(thirdPartyPluginVisible(rom, hybrid.id), true);
  assert.equal(thirdPartyAssetVisible(rom, hybrid.id, []), true);
});

test('layout:<short> opens the layout only, not the other surfaces of its package', () => {
  const hybrid = plugin({
    id: 'hybrid-layout',
    kind: ['layout', 'widget', 'page'],
    slots: ['root', 'cockpit.widget'],
    route: '/hybrid',
  });
  const withShort = { ...ada, permissions: [...employee, 'layout:hybrid-layout'] };
  const view = surfacesForViewer(withShort, [hybrid]);
  if ('layouts' in view) {
    assert.deepEqual(view.layouts, ['hybrid-layout']);
    assert.deepEqual(view.widgets, [], 'the widget half needs plugin:<id>');
    assert.equal(view.pages.includes('/hybrid'), false, 'the page half needs plugin:<id>');
  }
  const whole = { ...ada, permissions: [...employee, 'plugin:hybrid-layout'] };
  const full = surfacesForViewer(whole, [hybrid]);
  if ('layouts' in full) {
    assert.deepEqual(full.layouts, ['hybrid-layout']);
    assert.deepEqual(full.widgets, ['hybrid-layout']);
    assert.ok(full.pages.includes('/hybrid'));
  }
});

test('a bundled layout also opens with plugin:<id>', () => {
  const bundledByPlugin = { ...ada, permissions: ['plugin:@timon/ui-layout'] };
  assert.equal(pluginVisible(uiLayout, bundledByPlugin), true);
});

test('attachSurfaces keeps the original payload and adds `surfaces`', () => {
  const payload = { edition: 'expert', modules: [{ id: '@timon/kanban', active: true }] };
  const out = attachSurfaces(payload, ada, [kanban]);
  assert.equal(out.edition, 'expert');
  assert.equal(out.modules[0]?.active, true, 'kernel truth is not rewritten');
  assert.ok('surfaces' in out);
  if ('pages' in out.surfaces) {
    assert.equal(out.surfaces.pages.includes('/kanban'), false);
  }
});

const uiTheme: PluginPublic = plugin({
  id: '@timon/ui-theme',
  source: 'bundled',
  kind: ['theme'],
  slots: ['theme', 'settings.section'],
  client: null,
  signed: null,
});
const pluginTheme: PluginPublic = plugin({
  id: 'plugin-theme',
  kind: ['theme'],
  slots: ['theme'],
  label: 'Nord',
});

test('a third-party theme opens only its gallery entry, capability and assets with theme:<short>', () => {
  const withTheme = { ...ada, permissions: [...employee, 'theme:plugin-theme'] };
  assert.equal(pluginVisible(pluginTheme, withTheme), true);
  assert.deepEqual(filterGallery([pluginTheme, acme], withTheme).map((item) => item.id), ['plugin-theme']);
  assert.equal(thirdPartyAssetVisible(withTheme, pluginTheme.id, pluginTheme.kind), true);
  assert.equal(thirdPartyPluginVisible(withTheme, pluginTheme.id), false, 'host API stays closed');

  const view = surfacesForViewer(withTheme, [pluginTheme]);
  if ('themes' in view) {
    assert.deepEqual(view.themes, ['plugin-theme']);
    assert.deepEqual(view.plugins, ['plugin-theme']);
  }

  const forged = { ...ada, permissions: [...employee, 'theme:acme-crm'] };
  assert.equal(pluginVisible(acme, forged), false, 'a widget/page is not a theme');
  assert.equal(thirdPartyAssetVisible(forged, acme.id, acme.kind), false);
  assert.equal(pluginVisible(pluginTheme, ada), false, 'a theme without its grant stays hidden');
  assert.equal(thirdPartyAssetVisible(ada, pluginTheme.id, pluginTheme.kind), false);
});

test('T.7: choosing a theme requires theme:<short> or plugin:<id>; refusal is silent', () => {
  assert.equal(viewerMayChooseChrome(ada, uiTheme, 'theme'), true);
  assert.equal(viewerMayChooseChrome(ada, pluginTheme, 'theme'), false);
  const withTheme = { ...ada, permissions: [...employee, 'theme:plugin-theme'] };
  assert.equal(viewerMayChooseChrome(withTheme, pluginTheme, 'theme'), true);
  assert.equal(viewerMayChooseChrome(rom, pluginTheme, 'theme'), true);

  const gallery = [uiTheme, pluginTheme, agenda];
  assert.equal(resolveChromeChoice(gallery, withTheme, 'plugin-theme', 'theme')?.id, 'plugin-theme');
  assert.equal(resolveChromeChoice(gallery, ada, 'plugin-theme', 'theme'), null);
  assert.equal(resolveChromeChoice(gallery, ada, 'missing-theme', 'theme'), null);
  assert.equal(resolveChromeChoice(gallery, ada, 'hello', 'theme'), null);
  assert.equal(resolveChromeChoice(gallery, withTheme, agenda.id, 'theme'), null, 'wrong kind');
  assert.equal(resolveChromeChoice(gallery, withTheme, 1, 'theme'), null);

  const idle = { ...pluginTheme, state: 'disabled' as const };
  assert.equal(resolveChromeChoice([idle], withTheme, 'plugin-theme', 'theme'), null);

  assert.equal(resolveChromeChoice(gallery, withTheme, 'blank-layout', 'layout'), null);
  const withLayout = { ...ada, permissions: [...employee, 'layout:blank-layout'] };
  assert.equal(resolveChromeChoice([blankLayout], withLayout, 'blank-layout', 'layout')?.id, 'blank-layout');
});
