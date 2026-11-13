/**
 * `@rooks/missions:chat` params (ISLAND-WORKSPACE.md §7): one shape whatever
 * the source handed, so the workspace tells an already open chat by its
 * params, and nothing a drag carries reaches the chat unchecked.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CHAT_ISLAND_TYPE, chatHref, chatIslandContent, chatIslandShown, chatMissionHref, parseChatIslandParams, routeChatOf, routeChatOfUrl, routeChatParams } from './chat-island-params';
import { collectLeaves, defaultIslandTree, insertAt, setRouteParams, type IslandTree } from './island-tree';

test('the params always come out in one shape', () => {
  assert.deepEqual(parseChatIslandParams({ agent: 'initech.coder' }), { agent: 'initech.coder', missionId: null, fresh: false });
  assert.deepEqual(parseChatIslandParams({ agent: 'a', missionId: 'm-1' }), { agent: 'a', missionId: 'm-1', fresh: false });
  assert.deepEqual(parseChatIslandParams({ agent: 'a', fresh: true }), { agent: 'a', missionId: null, fresh: true });
  // A chat bound to a mission is not fresh, whatever the source said.
  assert.deepEqual(parseChatIslandParams({ agent: 'a', missionId: 'm', fresh: true }), { agent: 'a', missionId: 'm', fresh: false });
  assert.deepEqual(parseChatIslandParams(chatIslandContent('a').params), parseChatIslandParams({ agent: 'a' }));
  assert.equal(chatIslandContent('a', 'm').type, CHAT_ISLAND_TYPE);
  assert.equal(CHAT_ISLAND_TYPE, '@rooks/missions:chat');
});

test('what is not an agent or a mission id is refused', () => {
  for (const raw of [null, 'a', {}, { agent: '' }, { agent: '../etc' }, { agent: 'a b' }, { agent: 'x'.repeat(129) },
    { agent: 'a', missionId: 42 }, { agent: 'a', missionId: '../m' }, { agent: 'a', missionId: '' }]) {
    assert.equal(parseChatIslandParams(raw), null, JSON.stringify(raw));
  }
});

test('the type is registered exclusive, unmounted when inactive, with volatile conversations', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'plugins-client', 'missions.tsx'), 'utf8');
  const block = source.slice(source.indexOf("slot: 'island.content'"), source.indexOf('}, ChatIsland)'));
  assert.match(block, /exclusive: CHAT_COLUMNS_EXCLUSIVE/);
  assert.match(block, /volatileParams: \['missionId', 'fresh'\]/);
  assert.match(block, /minWidth: 360/);
  assert.doesNotMatch(block, /keepMounted/, 'an inactive chat tab holds no stream (Q12)');
});

test('a chat link escapes the agent and the mission', () => {
  assert.equal(chatHref('a b', 'm/1&x=2'), '/chat?agent=a%20b&mission=m%2F1%26x%3D2');
  assert.equal(chatHref('a', ''), '/chat?agent=a');
  assert.equal(chatMissionHref('m/1'), '/chat?mission=m%2F1');
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
  });
}

// A link copied by hand forgets to escape one of its ids (the Kanban card did,
// with the mission id): every `/chat?agent=` / `/chat?mission=` goes through
// the helpers. `notification-href.ts` mirrors the daemon's push payload, and
// says so.
test('chat links are built by chatHref, never by hand', () => {
  const allowed = new Set(['chat-island-params.ts', 'notification-href.ts']);
  const offenders = sources(join(process.cwd(), 'src'))
    .filter((path) => !allowed.has(path.split(/[\\/]/).pop() ?? ''))
    .filter((path) => /`\/chat\?(?:agent|mission)=\$\{/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, []);
});

// TIM-0140: a chat island opened on the main agent, moved to the coder's
// mission from its rail, was still titled after the main agent and reopened
// on it. Its params take the agent of the conversation it shows.
test('a chat island keeps the agent of the conversation it shows', () => {
  assert.deepEqual(
    chatIslandShown({ agent: 'kids.main', missionId: 'm-main' }, 'm-coder', 'kids.coder'),
    { agent: 'kids.coder', missionId: 'm-coder', fresh: false },
  );
  // Same agent, other mission: only the mission moves.
  assert.deepEqual(
    chatIslandShown({ agent: 'kids.main', missionId: null }, 'm-2', 'kids.main'),
    { agent: 'kids.main', missionId: 'm-2', fresh: false },
  );
  // Already said: nothing to write, so no write per turn.
  assert.equal(chatIslandShown({ agent: 'kids.coder', missionId: 'm-coder' }, 'm-coder', 'kids.coder'), null);
  // An owner the params would refuse leaves the tab's agent.
  assert.deepEqual(
    chatIslandShown({ agent: 'kids.main', missionId: 'm-1' }, 'm-2', 'not an agent/'),
    { agent: 'kids.main', missionId: 'm-2', fresh: false },
  );
  // What is written reads back as is.
  const written = chatIslandShown({ agent: 'kids.main', missionId: 'm-main' }, 'm-coder', 'kids.coder');
  assert.deepEqual(parseChatIslandParams(written), written);
});

// TIM-0140: the main agent's view split in two, the coder's conversation
// picked in the page's panel, the main agent's beside it. The tree is the
// project's: one row for every agent of the project.
function splitView(kept: Record<string, string> = { view: 'kids.main', agent: 'kids.coder', missionId: 'm-coder' }): IslandTree {
  const base = defaultIslandTree();
  const split = insertAt(base, collectLeaves(base.root)[0]!.id, 'right', chatIslandContent('kids.main', 'm-main')).tree;
  return setRouteParams(split, kept).tree;
}

test('routeChatParams: kept for another agent only, with the view it was picked on', () => {
  assert.deepEqual(routeChatParams('kids.main', { agent: 'kids.coder', missionId: 'm-coder' }), { view: 'kids.main', agent: 'kids.coder', missionId: 'm-coder' });
  assert.deepEqual(routeChatParams('kids.main', { agent: 'kids.main', missionId: 'm-2' }), {}, 'the view\'s own agent: the URL says it');
  assert.deepEqual(routeChatParams('kids.main', null), {});
  assert.deepEqual(routeChatParams('kids.main', { agent: 'not an agent/', missionId: 'm' }), {});
  assert.deepEqual(routeChatParams('', { agent: 'kids.coder', missionId: 'm' }), {});
});

test('routeChatOf: the kept conversation comes back on its own view, never on another agent\'s', () => {
  const tree = splitView();
  const coder = { agent: 'kids.coder', missionId: 'm-coder' };
  // Back by the main agent's tab: it names the conversation beside.
  assert.deepEqual(routeChatOf(tree, 'kids.main', 'm-main'), coder);
  assert.deepEqual(routeChatOf(tree, 'kids.main', null), coder);
  assert.deepEqual(routeChatOf(tree, 'kids.main', 'm-coder'), coder, 'reloaded: the URL names it');
  // Another agent of the project reads the same row: its view follows its URL.
  assert.equal(routeChatOf(tree, 'kids.reviewer', 'm-rev'), null);
  assert.equal(routeChatOf(tree, 'kids.reviewer', null), null);
  assert.equal(routeChatOf(tree, null, null), null);
  // A conversation of the view nowhere on screen, or a link, wins.
  assert.equal(routeChatOf(tree, 'kids.main', 'm-other'), null);
  assert.equal(routeChatOf(tree, 'kids.main', 'm-main', true), null);
  // Nothing kept, or something forged.
  assert.equal(routeChatOf(splitView({}), 'kids.main', null), null);
  assert.equal(routeChatOf(splitView({ view: 'kids.main', agent: 'kids.main', missionId: 'm-1' }), 'kids.main', null), null);
});

test('routeChatOfUrl: a highlight or a network alert is a link', () => {
  const tree = splitView();
  assert.equal(routeChatOfUrl(tree, new URLSearchParams('agent=kids.main&mission=m-main'))?.agent, 'kids.coder');
  assert.equal(routeChatOfUrl(tree, new URLSearchParams('agent=kids.main&mission=m-main&highlight=p1')), null);
  assert.equal(routeChatOfUrl(tree, new URLSearchParams('agent=kids.main&mission=m-main&egress=1')), null);
});

test('routeChatOfUrl: a new conversation asked for on the view is not replaced by the kept one', () => {
  const tree = splitView();
  // The New picker of the page's chat: `newMissionHref(main)`.
  assert.equal(routeChatOfUrl(tree, new URLSearchParams('agent=kids.main&fresh=1')), null);
  assert.equal(routeChatOfUrl(tree, new URLSearchParams('agent=kids.main'))?.agent, 'kids.coder');
});
