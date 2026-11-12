import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeWorkspaceWidgets, workspaceWidgets } from '../components/widget-host/widget-defaults';
import type { ContraintesWidget } from '../components/widget-host/widget-layout';
import { MAIN_AGENT_WIDGET_ID } from './main-agent-card';
import { ADD_WIDGET_IDS, isAddWidgetPlaceholder } from '../components/widget-host/add-widget';

/** A catalogue wider than what the starters place: what is NOT shipped on a
 *  view must land in the palette, not on the board. */
const ids = [
  MAIN_AGENT_WIDGET_ID,
  'plugin:@rooks/agents:notifications', 'plugin:@rooks/agents:tasks', 'plugin:@rooks/ui-layout:clock',
  'plugin:@rooks/missions:Missions', 'plugin:@rooks/workflows:trace', 'plugin:@rooks/files-widget:Files',
  'plugin:@rooks/kanban:project-todo', 'plugin:@rooks/kanban:todo', 'plugin:@rooks/git:repository',
  ...ADD_WIDGET_IDS,
  'plugin:@rooks/docker-supervision:docker', 'plugin:@rooks/skills-widget:skills', 'plugin:@rooks/mcp-widget:mcp',
  'plugin:@rooks/projects:overview', 'plugin:@rooks/agents:team', 'plugin:@rooks/video-factory:video',
];
const constraints: ContraintesWidget[] = ids.map(id => ({ id, hauteurDefaut: 260, hauteurMin: 76, railDefaut: 'gauche', rangDefaut: 0 }));

test('a fresh install opens on the short arrangement the product ships (05/11/2026)', () => {
  const [add, add2] = ADD_WIDGET_IDS;
  const cockpit = mergeWorkspaceWidgets(null, constraints, '/').filter(w => !w.removed);
  // The centre of the cockpit is the main agent's chat: that IS the first
  // screen of the product, and a starter that named anything else would give
  // a new install a board with no conversation on it.
  const centre = cockpit.find(w => w.rail === 'centre');
  assert.equal(centre?.id, MAIN_AGENT_WIDGET_ID);
  assert.equal(centre?.heightMode, 'fill');
  const column = (cards: typeof cockpit, rail: string) => cards.filter(w => w.rail === rail).sort((a, b) => a.rang - b.rang);
  const parRail = (rail: string) => column(cockpit, rail).map(w => w.id);
  const shares = (cards: typeof cockpit, rail: string) => column(cards, rail).map(w => w.fillPercent);
  assert.deepEqual(parRail('gauche'), ['plugin:@rooks/agents:notifications', add]);
  assert.deepEqual(shares(cockpit, 'gauche'), [66, 34], 'the notifications take two thirds, « Your widget here » the rest');
  assert.deepEqual(parRail('centre'), [MAIN_AGENT_WIDGET_ID]);
  assert.deepEqual(parRail('droite'), ['plugin:@rooks/kanban:todo', 'plugin:@rooks/agents:tasks']);
  assert.deepEqual(shares(cockpit, 'droite'), [50, 50]);
  // Frameless and transparent: the cockpit's cards sit on the background
  // rather than in boxes; the dashed placeholder draws its own outline.
  assert.ok(cockpit.filter(w => !isAddWidgetPlaceholder(w.id)).every(w => w.borderless && w.transparent));

  const chat = mergeWorkspaceWidgets(null, constraints, '/chat').filter(w => !w.removed);
  const short = (rail: string) => column(chat, rail).map(w => w.id.split(':').at(-1));
  assert.deepEqual(short('chat.left.widget'), ['Missions', 'Files']);
  assert.deepEqual(shares(chat, 'chat.left.widget'), [50, 50]);
  assert.deepEqual(short('chat.right.widget'), ['repository', 'docker']);
  assert.deepEqual(shares(chat, 'chat.right.widget'), [66, 34]);
  assert.ok(chat.every(w => !w.group), 'no tab stacks on a fresh chat');

  const canvas = mergeWorkspaceWidgets(null, constraints, '/agents').filter(w => !w.removed);
  assert.deepEqual(canvas.map(w => [w.rail, w.id]).sort(), [['agents.left.widget', add], ['agents.right.widget', add2]].sort(),
    'the agents canvas starts bare: a placeholder per column');
  assert.ok(canvas.every(w => w.heightMode !== 'fill'), 'alone in its column, a placeholder keeps its own height');

  // Nothing shipped places these, on any view.
  for (const gone of ['video-factory', 'clock', 'trace', 'skills', 'mcp', 'project-todo']) {
    assert.ok([...cockpit, ...chat, ...canvas].every(w => !w.id.includes(gone)), gone);
  }
  assert.ok(chat.every(w => w.id !== MAIN_AGENT_WIDGET_ID));
});

test('saved placements survive and new plugins stay in the palette', () => {
  const saved = [{ id: constraints[0]!.id, rail: 'droite', rang: 0, hauteur: 420, transparent: true, untitled: true }];
  const result = mergeWorkspaceWidgets(saved, constraints, '/');
  assert.deepEqual(result.find(w => w.id === saved[0]!.id), saved[0]);
  assert.ok(result.filter(w => w.id !== saved[0]!.id).every(w => w.removed));
  assert.ok(mergeWorkspaceWidgets([], constraints, '/').every(w => w.removed));
});

test('a starter never places a widget this install does not have', () => {
  // The chat arrangement names modules that a lite install, or a machine
  // without Docker, simply never registers. What is absent from the
  // catalogue is absent from the board — and the stack it belonged to keeps
  // its other tabs rather than breaking.
  const partial = constraints.filter(c => c.id !== 'plugin:@rooks/docker-supervision:docker');
  const chat = mergeWorkspaceWidgets(null, partial, '/chat').filter(w => !w.removed);
  assert.ok(chat.every(w => !w.id.includes('docker')));
  assert.deepEqual(chat.filter(w => w.rail === 'chat.right.widget').map(w => w.id), ['plugin:@rooks/git:repository']);
});

test('a scope that has not answered yet paints nothing, an answered empty one paints the starters', () => {
  // Before the read lands, `raw` is `null` and so is a stored "nothing": only
  // `known` tells them apart, and only the second one deserves the starters.
  assert.deepEqual(workspaceWidgets(null, false, constraints, '/'), []);
  assert.deepEqual(workspaceWidgets([{ id: constraints[0]!.id, rail: 'droite', rang: 0, hauteur: 420 }], false, constraints, '/'), []);
  const fresh = workspaceWidgets(null, true, constraints, '/').filter(w => !w.removed);
  assert.equal(fresh.length, 5, 'notifications and « Your widget here », the main agent, TODO and Tasks');
  const stored = workspaceWidgets([{ id: constraints[0]!.id, rail: 'droite', rang: 0, hauteur: 420 }], true, constraints, '/');
  assert.equal(stored.find(w => w.id === constraints[0]!.id)?.hauteur, 420);
});

test('a widget placed by default lands in its zone on every view, stored layout or not', () => {
  const bell = 'plugin:@rooks/notifications:bell';
  const withBell: ContraintesWidget[] = [
    ...constraints,
    { id: bell, hauteurDefaut: 320, hauteurMin: 160, railDefaut: 'topbar.widget', rangDefaut: 99, placedByDefault: true },
  ];
  // A view with a stored layout that predates the widget: it must not vanish
  // from the bar into the palette.
  const saved = [{ id: constraints[0]!.id, rail: 'droite', rang: 0, hauteur: 420 }];
  for (const [raw, view] of [[saved, '/'], [null, '/'], [null, '/kanban'], [[], '/chat']] as const) {
    const placed = mergeWorkspaceWidgets(raw, withBell, view).find(w => w.id === bell);
    assert.equal(placed?.rail, 'topbar.widget', `placed on ${view} (${raw === null ? 'nothing stored' : 'stored'})`);
    assert.ok(!placed?.removed);
  }
  // Its removal is the user's, and sticks.
  const removed = [...saved, { id: bell, rail: 'topbar.widget', rang: 0, hauteur: 320, removed: true }];
  assert.equal(mergeWorkspaceWidgets(removed, withBell, '/').find(w => w.id === bell)?.removed, true);
  // So does a move into a rail.
  const moved = [...saved, { id: bell, rail: 'sidebar.left.widget', rang: 0, hauteur: 320 }];
  assert.equal(mergeWorkspaceWidgets(moved, withBell, '/').find(w => w.id === bell)?.rail, 'sidebar.left.widget');
});

test('a renamed widget takes over the place its former id had on screen', () => {
  const bell = 'plugin:@rooks/notifications:bell';
  const inbox = 'plugin:@rooks/notifications:inbox';
  const withBell: ContraintesWidget[] = [
    ...constraints,
    { id: bell, hauteurDefaut: 320, hauteurMin: 160, railDefaut: 'topbar.widget', rangDefaut: 99, placedByDefault: true, formerIds: [inbox] },
  ];
  const placedInbox = [{ id: inbox, rail: 'sidebar.left.widget', rang: 0, hauteur: 300, borderless: true }];
  const inherited = mergeWorkspaceWidgets(placedInbox, withBell, '/').find(w => w.id === bell);
  assert.equal(inherited?.rail, 'sidebar.left.widget');
  assert.equal(inherited?.hauteur, 300);
  assert.equal(inherited?.borderless, true);
  // A former id the user had put away hands nothing down: the widget goes to
  // its default zone, like for anyone.
  const removedInbox = [{ ...placedInbox[0]!, removed: true }];
  assert.equal(mergeWorkspaceWidgets(removedInbox, withBell, '/').find(w => w.id === bell)?.rail, 'topbar.widget');
});

test('a chat opened on another view starts from the places of /chat, then keeps its own (Q14)', () => {
  // A view whose row exists: every card it did not place is stored taken out.
  const kanban = mergeWorkspaceWidgets(null, constraints, '/kanban');
  const stored = kanban.filter(w => w.id !== 'plugin:@rooks/docker-supervision:docker');
  // No chat zone mounted: nothing changes, nothing chat-like is claimed.
  const without = mergeWorkspaceWidgets(stored, constraints, '/kanban');
  assert.ok(without.filter(w => w.rail.startsWith('chat.')).every(w => w.removed), 'no chat places without a chat');

  const withChat = mergeWorkspaceWidgets(stored, constraints, '/kanban', true).filter(w => !w.removed);
  assert.deepEqual(withChat.filter(w => w.rail === 'chat.left.widget').map(w => w.id.split(':').at(-1)),
    ['Missions', 'Files'], 'stored as taken out by default: placed like on /chat');
  assert.equal(withChat.filter(w => w.rail === 'chat.right.widget').length, 2, 'absent from the row: placed too');
});

test('a card removed from a chat column of a view stays removed there (Q14)', () => {
  const kanban = mergeWorkspaceWidgets(null, constraints, '/kanban', true);
  const removed = kanban.map(w => (w.id === 'plugin:@rooks/git:repository' ? { ...w, removed: true } : w));
  assert.equal(removed.find(w => w.id === 'plugin:@rooks/git:repository')!.rail, 'chat.right.widget');
  const again = mergeWorkspaceWidgets(removed, constraints, '/kanban', true);
  assert.equal(again.find(w => w.id === 'plugin:@rooks/git:repository')!.removed, true);
  // A card the view shows elsewhere is not moved: one card, one place.
  const elsewhere = removed.map(w => (w.id === 'plugin:@rooks/files-widget:Files' ? { ...w, rail: 'gauche', removed: undefined } : w));
  assert.equal(mergeWorkspaceWidgets(elsewhere, constraints, '/kanban', true).find(w => w.id === 'plugin:@rooks/files-widget:Files')!.rail, 'gauche');
});

test('/chat keeps its own rule: a stored row is not re-seeded', () => {
  const stored = mergeWorkspaceWidgets(null, constraints, '/chat').map(w => (w.rail.startsWith('chat.') ? { ...w, rail: 'gauche', removed: true } : w));
  const merged = mergeWorkspaceWidgets(stored, constraints, '/chat', true);
  assert.ok(merged.filter(w => w.id === 'plugin:@rooks/files-widget:Files').every(w => w.removed));
});

test('the Skills and MCP cards take over their places and their tab stack under @rooks/agents (TODO #357)', () => {
  const skills = 'plugin:@rooks/skills-widget:skills';
  const mcp = 'plugin:@rooks/mcp-widget:mcp';
  const stack = 'stack:chat.right.skills:1';
  const stored = [
    { id: 'plugin:@rooks/agents:skills', rail: 'chat.right.widget', rang: 1, hauteur: 300, group: stack },
    { id: 'plugin:@rooks/agents:mcp', rail: 'chat.right.widget', rang: 2, hauteur: 300, group: stack, activeTab: true },
  ];
  const renamed: ContraintesWidget[] = [
    { id: skills, hauteurDefaut: 260, hauteurMin: 140, railDefaut: 'gauche', rangDefaut: 0, formerIds: ['plugin:@rooks/agents:skills'] },
    { id: mcp, hauteurDefaut: 220, hauteurMin: 120, railDefaut: 'gauche', rangDefaut: 0, formerIds: ['plugin:@rooks/agents:mcp'] },
  ];
  const merged = mergeWorkspaceWidgets(stored, renamed, '/chat', true);
  const s = merged.find(w => w.id === skills)!;
  const m = merged.find(w => w.id === mcp)!;
  assert.equal(s.rail, 'chat.right.widget');
  assert.equal(m.rail, 'chat.right.widget');
  assert.equal(s.group, stack);
  assert.equal(m.group, stack);
  assert.ok(m.activeTab && !s.activeTab, 'MCP stays the tab shown');
  assert.ok(!s.removed && !m.removed);
});

test('TODO #278: the single Git card takes over the place of the former publication card, else of the Git panel', () => {
  const git = constraints.find(c => c.id === 'plugin:@rooks/git:repository')!;
  const withFormer = constraints.map(c => c === git
    ? { ...c, formerIds: ['plugin:@rooks/git:git-remote', 'plugin:@rooks/git:Git'] }
    : c);
  const both = [
    { id: 'plugin:@rooks/git:Git', rail: 'chat.left.widget', rang: 3, hauteur: 300 },
    { id: 'plugin:@rooks/git:git-remote', rail: 'chat.right.widget', rang: 1, hauteur: 250 },
  ];
  const a = mergeWorkspaceWidgets(both, withFormer, '/chat').find(w => w.id === git.id);
  assert.equal(a?.rail, 'chat.right.widget');
  assert.equal(a?.removed, undefined);
  // The publication card had been taken off: the Git panel's place is used.
  const panelOnly = [both[0]!, { ...both[1]!, removed: true }];
  const b = mergeWorkspaceWidgets(panelOnly, withFormer, '/chat').find(w => w.id === git.id);
  assert.equal(b?.rail, 'chat.left.widget');
});

// TODO #479: the agent strip became the Working agents widget. It was on
// screen on every view, so a view stored before it gets it in the middle of
// the top bar, whatever it did with the former « Agents list » card. The
// marker is the id's absence from the row: it did not exist before #479, and a
// row that names it was written since — a removal there is the user's.
test('Working agents lands in the middle of the top bar on every view that never named it', () => {
  const working = 'plugin:@rooks/agents:working';
  const team = 'plugin:@rooks/agents:team';
  const withWorking: ContraintesWidget[] = [
    ...constraints.filter(c => c.id !== team),
    { id: working, hauteurDefaut: 300, hauteurMin: 120, railDefaut: 'topbar.center.widget', rangDefaut: 99, placedByDefault: true },
  ];
  const placeOf = (raw: unknown, view = '/') => mergeWorkspaceWidgets(raw, withWorking, view).find(w => w.id === working);
  for (const view of ['/', '/chat', '/agents']) {
    assert.equal(placeOf(null, view)?.rail, 'topbar.center.widget', `fresh install, ${view}`);
    assert.ok(!placeOf(null, view)?.removed);
  }
  // Views customised before #479: the list card removed, placed in the
  // cockpit, or placed in a chat column tab (the regression, 28/10/2026).
  for (const stored of [
    [{ id: MAIN_AGENT_WIDGET_ID, rail: 'centre', rang: 0, hauteur: 520 }, { id: team, rail: 'gauche', rang: 3, hauteur: 300, removed: true }],
    [{ id: MAIN_AGENT_WIDGET_ID, rail: 'centre', rang: 0, hauteur: 520 }, { id: team, rail: 'gauche', rang: 1, hauteur: 280 }],
    [{ id: team, rail: 'chat.right.widget#muvis5up', rang: 1, hauteur: 300 }],
  ]) {
    for (const view of ['/', '/chat']) {
      assert.equal(placeOf(stored, view)?.rail, 'topbar.center.widget', `${view} ${JSON.stringify(stored)}`);
      assert.ok(!placeOf(stored, view)?.removed);
    }
  }
  // Removed from the top bar after #479: it stays away, on that view only.
  const away = [{ id: working, rail: 'topbar.center.widget', rang: 0, hauteur: 300, removed: true }];
  assert.equal(placeOf(away)?.removed, true);
  assert.equal(placeOf([], '/chat')?.removed, undefined);
  // Moved by hand: it stays where it was put.
  assert.equal(placeOf([{ id: working, rail: 'sidebar.left.widget', rang: 0, hauteur: 300 }])?.rail, 'sidebar.left.widget');
});
