/**
 * The island workspace's contract for a THIRD-PARTY plugin (client API 8,
 * `docs/ISLAND-WORKSPACE.md` §5, step 11).
 *
 * A bundled content (terminal, browser, chat, file) has no privilege over a
 * third-party one: same slot, same admission, same registry, same calls. What
 * this file proves is the plugin's side of that promise — what goes through
 * `clientContext` and `@timon/ui`, never an import of the app's internals.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientContext } from './plugin-host/loader';
import { declareSlot, resetSlotsForTests, slotEntries } from './plugin-host/slots';
import { UI_KIT } from './plugin-host/ui-kit';
import { islandContentTypes, ISLAND_CONTENT_SLOT, useIslandContent } from '../components/islands/island-content';
import { openInIsland } from './island-bus';
import { startIslandDrag } from './island-drag';

const Board = () => null;
const parseParams = (raw: unknown) => {
  const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
  return typeof id === 'string' && id.length <= 64 ? { id } : null;
};

test('a third-party plugin declaring `island.content` registers a content type `<pluginId>:<key>`', () => {
  resetSlotsForTests();
  declareSlot(ISLAND_CONTENT_SLOT, 'list');
  const ctx = clientContext('@acme/crm', [ISLAND_CONTENT_SLOT]);
  ctx.slots.register({
    slot: ISLAND_CONTENT_SLOT,
    key: 'board',
    island: { title: 'Board', parseParams, params: { id: { type: 'string', required: true, maxLength: 64 } } },
  }, Board);

  const types = islandContentTypes(slotEntries(ISLAND_CONTENT_SLOT));
  const board = types.get('@acme/crm:board');
  assert.ok(board, 'the type id is computed by the host from the plugin id and the key');
  assert.equal(board.options.title, 'Board');
  assert.deepEqual(board.options.parseParams({ id: 'q3' }), { id: 'q3' });
  assert.equal(board.options.parseParams({ id: 3 }), null);
  resetSlotsForTests();
});

test('a plugin that does not declare `island.content` is refused, whatever else it declares', () => {
  resetSlotsForTests();
  declareSlot(ISLAND_CONTENT_SLOT, 'list');
  const ctx = clientContext('@acme/widget', ['cockpit.widget']);
  assert.throws(() => ctx.slots.register({
    slot: ISLAND_CONTENT_SLOT,
    key: 'board',
    island: { title: 'Board', parseParams },
  }, Board));
  assert.equal(slotEntries(ISLAND_CONTENT_SLOT).length, 0);
  resetSlotsForTests();
});

test('`@timon/ui` hands a plugin the very calls the product\'s own contents use', () => {
  assert.equal(UI_KIT.useIslandContent, useIslandContent);
  assert.equal(UI_KIT.startIslandDrag, startIslandDrag);
  assert.equal(UI_KIT.openInIsland, openInIsland);
});

test('`openInIsland` answers `false` when no workspace is on screen, instead of throwing', () => {
  assert.equal(openInIsland({ type: '@acme/crm:board', params: { id: 'q3' } }, { edge: 'center' }), false);
});
