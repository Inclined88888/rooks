/**
 * The onboarding tours' island arrangements (`orchestrator/src/onboarding-recipes.ts`)
 * as THIS browser applies them: every content goes through its type's real
 * `parseParams` — the last word, which can refuse what the daemon let through —
 * and the whole proposal applies to a fresh workspace without dropping a tab.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOST_ROUTE, collectLeaves, defaultIslandTree, type IslandParams } from './island-tree';
import { applyIslandsProposal, parseIslandsProposal, type KnownType } from './island-proposals';
import { parseTerminalIslandParams } from './terminal-island-params';
import { parseChatIslandParams } from './chat-island-params';
import { parseBrowserIslandParams } from '../components/browser-island';
import { parseWidgetCardParams } from '../components/islands/widget-card-island';
import { parseWidgetZoneParams } from '../components/islands/widget-zone-island';

type Recipe = { id: string; tool: string; payload: Record<string, unknown> };
type RecipesModule = {
  ONBOARDING_RECIPES: readonly Recipe[];
  fillRecipe: (payload: unknown, values: Record<string, string>) => unknown;
};

// The daemon's file, read as data: the two packages share no import.
const recipesUrl = pathToFileURL(join(process.cwd(), '..', 'orchestrator', 'src', 'onboarding-recipes.ts')).href;
const loadRecipes = () => import(recipesUrl) as Promise<RecipesModule>;

const VALUES = { '<project>': 'rooks-demo', '<chat-agent>': 'rooks-demo.coder', '<other-agent>': 'assistant.mails' };

const parsers: Record<string, (raw: unknown) => IslandParams | null> = {
  '@rooks/terminal-web:session': parseTerminalIslandParams,
  '@rooks/missions:chat': parseChatIslandParams,
  '@rooks/browser-embedded:view': parseBrowserIslandParams,
  '@rooks/ui-layout:widget-card': parseWidgetCardParams,
  '@rooks/ui-layout:widget-zone': parseWidgetZoneParams,
};
const types = new Map<string, KnownType>(Object.entries(parsers).map(([type, parseParams]) => [type, { title: type, parseParams }]));

function contentsOf(node: unknown, out: Array<{ type: string; params?: unknown }> = []): Array<{ type: string; params?: unknown }> {
  if (!node || typeof node !== 'object') return out;
  const n = node as { tabs?: Array<{ type: string; params?: unknown }>; children?: unknown[]; content?: { type: string; params?: unknown } };
  if (n.tabs) out.push(...n.tabs);
  if (n.content) out.push(n.content);
  for (const child of n.children ?? []) contentsOf(child, out);
  return out;
}

test('every island arrangement of the tours passes its types\' parseParams and applies', async (t) => {
  const { ONBOARDING_RECIPES, fillRecipe } = await loadRecipes();
  const islandRecipes = ONBOARDING_RECIPES.filter((r) => r.tool === 'islands_propose');
  assert.ok(islandRecipes.length >= 3);
  for (const recipe of islandRecipes) {
    await t.test(recipe.id, () => {
      const filled = fillRecipe(recipe.payload, VALUES) as { layout?: { root: unknown }; open?: { content: unknown } };
      for (const content of contentsOf(filled.layout?.root ?? filled.open)) {
        if (content.type === HOST_ROUTE) continue;
        const parse = parsers[content.type];
        assert.ok(parse, `${content.type} has a parser here`);
        assert.ok(parse(content.params ?? {}), `${content.type} refuses ${JSON.stringify(content.params)}`);
      }
      const proposal = parseIslandsProposal(filled);
      assert.ok(proposal, 'the stored payload reads back');
      const applied = applyIslandsProposal(proposal, defaultIslandTree(), types);
      assert.ok(applied.tree, 'applies to a fresh workspace');
      assert.deepEqual(applied.dropped, []);
      assert.ok(collectLeaves(applied.tree.root).length >= 2);
    });
  }
});

test('the daemon\'s menu mirror (`NAV_PAGES`) lists every entry the product registers', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const daemon = readFileSync(join(process.cwd(), '..', 'orchestrator', 'src', 'plugins-bundled', 'settings', 'nav-model.ts'), 'utf8');
  const mirrored = new Set([...daemon.matchAll(/\{ path: '(\/[a-z0-9/_-]*)'/g)].map((m) => m[1]));
  const dir = join(process.cwd(), 'src', 'plugins-client');
  const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  const registered = [...sources.matchAll(/registerNavItem\(ctx, \{ href: '(\/[a-z0-9/_-]*)'/g)].map((m) => m[1]);
  // The entry registered by hand (`triggers.tsx`).
  registered.push('/triggers');
  assert.ok(registered.length > 10);
  for (const href of registered) assert.ok(mirrored.has(href), `${href} is missing from NAV_PAGES`);
});

test('the developer code screen carries its widget columns in the same card', async () => {
  const { ONBOARDING_RECIPES, fillRecipe } = await loadRecipes();
  const { parseWidgetsProposal } = await import('./widget-proposals');
  const recipe = ONBOARDING_RECIPES.find((r) => r.id === 'developer.code-screen');
  assert.ok(recipe);
  const filled = fillRecipe(recipe.payload, VALUES) as { view: string; project: string; widgets?: Record<string, unknown> };
  assert.ok(filled.widgets, 'the columns travel with the islands');
  const part = parseWidgetsProposal({ ...filled.widgets, view: filled.view, project: filled.project });
  assert.ok(part, 'the column part reads as a widgets proposal');
  assert.deepEqual(Object.keys(part.zones ?? {}).sort(), ['chat.left.widget', 'chat.right.widget']);
});
