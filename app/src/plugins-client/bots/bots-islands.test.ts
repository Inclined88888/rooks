/**
 * `/bots` in two islands: the seeded tree (rail beside the route's chat) and
 * where a pick in the rail goes — `?agent=` on `/bots`, the chat brought to
 * the view everywhere else, never a page change.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_ISLAND_TYPE } from '@/lib/chat-island-params';
import { HOST_ROUTE, allLeaves, normalizeIslandTree, readIslandTree } from '@/lib/island-tree';
import { BOTS_RAIL_WIDGET, botsRailContent, botsSeedTree, isBotsRailTab, routeBotPick, WIDGET_CARD_TYPE } from './bots-islands';

test('the seeded tree puts the rail on the left and focuses the chat', () => {
  const tree = botsSeedTree();
  assert.equal(tree.root.kind, 'split');
  if (tree.root.kind !== 'split') return;
  assert.equal(tree.root.dir, 'row');
  const [rail, chat] = allLeaves(tree);
  assert.ok(rail && chat);
  assert.ok(isBotsRailTab(rail.tabs[0]!.content));
  assert.equal(chat.tabs[0]!.content.type, HOST_ROUTE);
  assert.equal(tree.focus, chat.id);
  assert.ok(Math.abs(tree.root.ratios.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('the seeded tree survives the stored-tree reader unchanged', () => {
  const tree = botsSeedTree();
  assert.deepEqual(readIslandTree(JSON.parse(JSON.stringify(tree))), normalizeIslandTree(tree));
});

test('the rail island is a widget card holding the rail widget', () => {
  assert.deepEqual(botsRailContent(), { type: WIDGET_CARD_TYPE, params: { widget: BOTS_RAIL_WIDGET } });
  assert.equal(isBotsRailTab({ type: WIDGET_CARD_TYPE, params: { widget: 'plugin:@timon/missions:Missions' } }), false);
});

const base = { agent: 'ada', workspace: true, tabs: [], inIsland: true };

test('on /bots a pick follows ?agent=', () => {
  assert.deepEqual(routeBotPick({ ...base, pathname: '/bots' }), { kind: 'route', href: '/bots?agent=ada' });
  assert.deepEqual(routeBotPick({ ...base, agent: 'a b', pathname: '/bots' }), { kind: 'route', href: '/bots?agent=a%20b' });
});

test('elsewhere an open chat of the bot is activated, not duplicated', () => {
  const tabs = [{ id: 't1', content: { type: CHAT_ISLAND_TYPE, params: { agent: 'ada', missionId: 'm1', fresh: false } } }];
  assert.deepEqual(routeBotPick({ ...base, pathname: '/kanban', tabs }), { kind: 'activate', tabId: 't1' });
});

test('elsewhere a new chat opens beside the rail island, or in the active island', () => {
  const content = { type: CHAT_ISLAND_TYPE, params: { agent: 'ada', missionId: null, fresh: false } };
  assert.deepEqual(routeBotPick({ ...base, pathname: '/' }), { kind: 'open', content, edge: 'right' });
  assert.deepEqual(routeBotPick({ ...base, pathname: '/', inIsland: false }), { kind: 'open', content, edge: 'center' });
});

test('without a workspace the pick falls back on /bots', () => {
  assert.deepEqual(routeBotPick({ ...base, pathname: '/', workspace: false }), { kind: 'route', href: '/bots?agent=ada' });
});
