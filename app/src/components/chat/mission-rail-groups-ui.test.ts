/**
 * The Missions widget grouped by orchestrator: children under their head, the
 * head's face pulsing while a child works, the fold toggle, the filter summary.
 * The grouping itself is covered by `lib/mission-rail-groups.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';

import type { MissionSummary } from './chat-types';

let layout: Record<string, unknown> = {};

function install(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

async function setupDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  // The rail's display row answers what the test set; the other side reads answer empty.
  install('fetch', async (input: RequestInfo | URL) => String(input).includes('missions.rail')
    ? Response.json({ layout, updatedAt: 1 })
    : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }));
  return dom;
}
let domReady: ReturnType<typeof setupDom> | null = null;

async function mount(missions: MissionSummary[], currentMissionId: string | null = null) {
  await (domReady ??= setupDom());
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { MissionRail } = await import('./mission-rail');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(MissionRail, {
      agentId: 'demo.main', missions, currentMissionId, onPick: () => {}, onNew: () => {},
    }));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const unmount = async () => { await React.act(async () => { root.unmount(); }); host.remove(); };
  return { host, until, unmount, React };
}

function mission(id: string, title: string, extra: Partial<MissionSummary> = {}): MissionSummary {
  return { id, mission: title, title, status: 'running', running: false, started_at: 1, ended_at: null, ...extra };
}

const MISSIONS = [
  mission('code', 'Code the feature', { origin: 'task', parent_mission_id: 'orch', turn_active: true }),
  mission('orch', 'Orchestrate the series', { origin: 'user' }),
  mission('solo', 'A chat on its own', { origin: 'user' }),
];

test('a group starts folded, unfolds at a click onto its island, and the head pulses while a child works', async () => {
  layout = { v: 1, showAvatar: true, mineOnly: false, groupByOrchestrator: true };
  const ui = await mount(MISSIONS);
  try {
    const group = () => ui.host.querySelector<HTMLElement>('[data-mission-group="orch"]');
    await ui.until(() => !!group(), 'the orchestrator group');
    const toggle = group()!.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!toggle) assert.fail('the head has no fold toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'groups start folded');
    assert.equal(toggle.getAttribute('aria-label'), 'Show its 1 missions');
    assert.ok(!group()!.textContent?.includes('Code the feature'), 'folded, the child is hidden');
    assert.equal(group()!.querySelector('[data-chip-avatar]')?.getAttribute('data-state'), 'thinking', 'folded, the head pulses for its working child');

    await ui.React.act(async () => { toggle.click(); });
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.getAttribute('aria-label'), 'Hide its 1 missions');
    assert.ok(group()!.textContent?.includes('Code the feature'), 'the child is inside the group');
    assert.ok(!group()!.textContent?.includes('A chat on its own'), 'a lone mission stays outside');
    const heads = group()!.querySelectorAll('[data-chip-avatar]');
    assert.equal(heads[0]?.getAttribute('data-state'), 'thinking', 'the head pulses for its working child');
    assert.equal(heads[1]?.getAttribute('data-state'), 'thinking', 'the child pulses itself');
    assert.ok(!ui.host.querySelector('.rooks-dots'), 'the dotted wave is gone');
    assert.match(ui.host.textContent ?? '', /All · 3/);

    // The child sits on a tinted island threaded by a pseudo-element spine.
    const child = ui.host.querySelector<HTMLElement>('[data-mission-row="code"]')!;
    for (const cls of ['bg-foreground/[0.04]', 'rounded-t-md', 'rounded-b-md', 'before:w-px', 'before:bg-foreground/15']) {
      assert.ok(child.classList.contains(cls), `the child row carries ${cls}`);
    }
    assert.ok(!Array.from(child.classList).some((cls) => /^border|^w-px$/.test(cls)), 'no border nor one-pixel element draws the spine');
    assert.ok(!ui.host.querySelector<HTMLElement>('[data-mission-row="orch"]')!.classList.contains('bg-foreground/[0.04]'), 'the head is off the island');

    await ui.React.act(async () => { toggle.click(); });
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(!group()!.textContent?.includes('Code the feature'), 'folded again, the child is hidden');
  } finally {
    await ui.unmount();
  }
});

test('with sub-agents unfolded by option, a group starts open and folds at a click', async () => {
  layout = { v: 1, showAvatar: true, mineOnly: false, groupByOrchestrator: true, expandSubagents: true };
  const ui = await mount(MISSIONS);
  try {
    const group = () => ui.host.querySelector<HTMLElement>('[data-mission-group="orch"]');
    await ui.until(() => group()?.textContent?.includes('Code the feature') === true, 'the unfolded group');
    const toggle = group()!.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    await ui.React.act(async () => { toggle.click(); });
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(!group()!.textContent?.includes('Code the feature'), 'folded by hand, the child is hidden');
  } finally {
    await ui.unmount();
  }
});

test('with the avatar hidden, a working mission shows a pulsing dot', async () => {
  layout = { v: 1, showAvatar: false, mineOnly: false, groupByOrchestrator: false };
  const ui = await mount(MISSIONS);
  try {
    await ui.until(() => !ui.host.querySelector('[data-chip-avatar]'), 'the avatars to be hidden');
    const dots = ui.host.querySelectorAll('[role="img"][aria-label="Working"]');
    assert.equal(dots.length, 1, 'only the working mission wears the dot');
    assert.ok(!ui.host.querySelector('[data-mission-group]'), 'ungrouped: every row is flat');
  } finally {
    await ui.unmount();
  }
});

test('the open mission sticks above the rows scrolling beneath it, inside a group too', async () => {
  layout = { v: 1, showAvatar: true, mineOnly: false, groupByOrchestrator: true };
  const ui = await mount(MISSIONS, 'code');
  try {
    const row = (id: string) => ui.host.querySelector<HTMLElement>(`[data-mission-row="${id}"]`);
    await ui.until(() => !!row('code'), 'the child row');
    // Each row isolates its avatar's z-index, so no face climbs over the sticky row.
    for (const id of ['orch', 'code', 'solo']) assert.ok(row(id)!.classList.contains('isolate'), `${id} is its own stacking context`);
    assert.ok(row('code')!.classList.contains('sticky') && row('code')!.classList.contains('z-10'), 'the open mission sticks above the others');
    assert.ok(!row('solo')!.classList.contains('z-10'));
    // The group draws no box: a sticky child is bound by the list, not by its group.
    const group = ui.host.querySelector<HTMLElement>('[data-mission-group="orch"]')!;
    assert.ok(group.classList.contains('contents'));
    // Groups fold by default, but the one holding the open mission is forced open.
    const toggle = group.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the open mission\'s group is unfolded');
    assert.ok(toggle.disabled, 'it cannot be folded over the open mission');
    assert.ok(row('code')!.classList.contains('ml-3'), 'the child keeps its indent');
    // Stuck, the open child keeps an opaque fill under the island tint.
    assert.ok(row('code')!.classList.contains('bg-card'));
    assert.ok(!row('code')!.classList.contains('bg-foreground/[0.04]'));
  } finally {
    await ui.unmount();
  }
});

test('under a role filter, a head of another role is dimmed, announced, and left out of the count', async () => {
  layout = { v: 1, showAvatar: true, mineOnly: false, groupByOrchestrator: true, expandSubagents: true };
  const ui = await mount([
    mission('code', 'Code the feature', { origin: 'task', parent_mission_id: 'orch', agent_role: 'coder' }),
    mission('orch', 'Orchestrate the series', { origin: 'user', agent_role: 'orchestrator' }),
    mission('solo', 'A chat on its own', { origin: 'user', agent_role: 'coder' }),
  ]);
  try {
    const row = (id: string) => ui.host.querySelector<HTMLElement>(`[data-mission-row="${id}"]`);
    await ui.until(() => !!row('orch'), 'the orchestrator group');
    assert.ok(!row('orch')!.hasAttribute('data-mission-context'), 'no filter, no context head');

    const trigger = ui.host.querySelector<HTMLButtonElement>('button[aria-label="Filter missions"]');
    if (!trigger) assert.fail('no filter button');
    await ui.React.act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const coderItem = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
      .find((el) => /coder/i.test(el.textContent ?? ''));
    await ui.until(() => !!coderItem(), 'the coder role in the filter menu');
    await ui.React.act(async () => { coderItem()!.click(); });

    await ui.until(() => row('orch')?.hasAttribute('data-mission-context') === true, 'the head to turn context');
    const head = row('orch')!;
    assert.ok(head.querySelector('.opacity-60'), 'the context head is dimmed');
    assert.ok(!head.querySelector('[class*="border-t"], [class*="border-b"], hr'), 'no rule draws the context');
    const sr = head.querySelector('.sr-only');
    assert.match(sr?.textContent ?? '', /Shown for context: not a .* mission/i, 'a screen reader hears why it is there');
    assert.ok(!row('code')!.hasAttribute('data-mission-context'), 'its coder child is not context');
    assert.ok(!row('solo')!.hasAttribute('data-mission-context'), 'a coder row is not context');
    assert.match(ui.host.textContent ?? '', /coder · 2/i, 'the summary counts only the coder missions');
  } finally {
    await ui.unmount();
  }
});
