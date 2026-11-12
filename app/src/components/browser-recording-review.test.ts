/**
 * The review drawer of a browser recording (TODO #461): each edit is one PATCH
 * of the daemon's operations, a flagged step blocks Learn until it is settled,
 * Learn opens the conversion mission, and attaching the skill it created — the
 * one the daemon names on the recording — is a click of the operator's, never
 * automatic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { browserRecordingDom, status, type FetchCall } from '@/lib/browser-recording-test-dom';
import type { BrowserRecordingMeta, RecordedStep } from '@/lib/browser-recording';

const ID = 'br-00000000-0000-4000-8000-000000000002';
const KEY = 'ghp_abcdefghijklmnopqrstuvwxyz0123';

function fakeDaemon() {
  let meta: BrowserRecordingMeta = {
    id: ID, profileId: 'p1', title: 'shop.example', startUrl: 'https://shop.example/', steps: 4, flagged: 1, truncated: false,
    stoppedReason: 'user', createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000, status: 'draft', learnMissionId: null, stepsAvailable: true,
  };
  let steps: RecordedStep[] = [
    { n: 1, t: 0, type: 'navigate', tabId: 't', url: 'https://shop.example/' },
    { n: 2, t: 1, type: 'input', tabId: 't', name: 'Search', value: 'running shoes' },
    { n: 3, t: 2, type: 'input', tabId: 't', name: 'Key', value: KEY, flagged: 'api-key' },
    { n: 4, t: 3, type: 'click', tabId: 't', text: 'Buy' },
  ];
  const patches: unknown[] = [];
  /** What the daemon records once the conversion mission created its skill. */
  let learnedSkillId: string | null = null;
  /** The agents whose backend runs without a shell (#469): the daemon's answer, not the UI's guess. */
  let learnAgents = [{ name: 'shopper', main: true }];
  const settle = () => {
    const flagged = steps.filter((step) => step.flagged).length;
    meta = { ...meta, steps: steps.length, flagged, status: flagged ? 'draft' : 'reviewed' };
  };
  const route = (call: FetchCall): Response | undefined => {
    const url = call.url;
    if (url === '/api/ui/native-browser/p1/recordings') return Response.json({ recordings: [meta] });
    if (url === `/api/ui/native-browser/recordings/${ID}` && call.method === 'GET') {
      return Response.json({ recording: meta.status === 'learned' ? { ...meta, learnedSkillId } : meta, steps });
    }
    if (url === `/api/ui/native-browser/recordings/${ID}` && call.method === 'PATCH') {
      const { ops } = call.body as { ops: Array<{ op: string; step?: number; name?: string; title?: string }> };
      patches.push(ops);
      for (const op of ops) {
        if (op.title) { meta = { ...meta, title: op.title }; continue; }
        steps = op.op === 'drop' ? steps.filter((step) => step.n !== op.step) : steps.map((step) => {
          if (step.n !== op.step) return step;
          const { flagged: _flagged, ...rest } = step;
          if (op.op === 'mask') return { ...rest, value: `{SECRET:${step.name}}` };
          if (op.op === 'unmask') return rest;
          if (op.op === 'param') return { ...step, param: op.name };
          return { ...step, name: op.name };
        });
      }
      settle();
      return Response.json({ recording: meta, steps });
    }
    if (url === `/api/ui/native-browser/recordings/${ID}/learn-agents`) return Response.json({ agents: learnAgents });
    if (url === `/api/ui/native-browser/recordings/${ID}/learn`) {
      meta = { ...meta, status: 'learned', learnMissionId: 'm-1' };
      return Response.json({ recording: meta, missionId: 'm-1' });
    }
    if (url === '/api/ui/missions/m-1?view=status') return Response.json({ agent_name: 'shopper', status: 'running', turn_complete: true });
    if (url === '/api/ui/skills') {
      return Response.json({ skills: [
        // Another conversion that ran at the same time: a browser- skill written since the recording.
        { id: 'browser-concurrent', title: 'Someone else\'s flow', updated_at: Date.now() },
        { id: 'browser-buy-shoes', title: 'Buy running shoes', updated_at: Date.now() },
        { id: 'browser-older', title: 'Older', updated_at: 0 },
        { id: 'notes', title: 'Notes', updated_at: Date.now() },
      ] });
    }
    if (url === '/api/ui/agents') {
      return Response.json({ agents: [
        { name: 'shopper', browser_profile_id: 'p1', skills: ['notes'] },
        { name: 'elsewhere', browser_profile_id: 'p2', skills: [] },
      ] });
    }
    if (url === '/api/ui/agents/shopper/config' && call.method === 'PATCH') return Response.json({ ok: true });
    return undefined;
  };
  return {
    route, patches, steps: () => steps, createSkill: (id: string) => { learnedSkillId = id; },
    offerAgents: (agents: Array<{ name: string; main: boolean }>) => { learnAgents = agents; },
  };
}

async function openReview(ui: Awaited<ReturnType<typeof browserRecordingDom>>) {
  await ui.until(() => !!ui.button('Recordings'), 'the recordings button');
  await ui.click(ui.button('Recordings'));
  await ui.until(() => !!document.querySelector('[data-browser-recording-review]'), 'the review drawer');
  await ui.click(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-browser-recording-review] li button'))[0]);
  await ui.until(() => document.querySelectorAll('[data-step]').length === 4, 'the steps');
}

const card = (n: number) => document.querySelector<HTMLElement>(`[data-step="${n}"]`);
const inCard = (n: number, label: string) => Array.from(card(n)?.querySelectorAll('button') ?? []).find((node) => node.textContent === label || node.getAttribute('aria-label') === label);

test('each edit is one PATCH, and Learn stays off while a flagged step is not settled', async () => {
  const daemon = fakeDaemon();
  const ui = await browserRecordingDom({ owner: true, route: daemon.route });
  try {
    await openReview(ui);
    const learn = () => ui.button('Learn');
    // The flagged value is put forward, masking proposed first.
    assert.equal(card(3)?.dataset.flagged, 'api-key');
    assert.ok(document.querySelector('[data-flagged-notice]'));
    assert.equal(card(3)?.querySelector('button')?.textContent, 'Mask value', 'mask comes first on a flagged step');
    assert.equal(learn()?.disabled, true);
    assert.match(document.querySelector('[aria-label="Learn"]')?.textContent ?? '', /Settle the 1 flagged step/);

    await ui.click(inCard(2, 'Make a parameter'));
    const nameField = card(2)?.querySelector<HTMLInputElement>('input[aria-label="Parameter name"]') ?? null;
    await ui.type(nameField, '1st');
    assert.equal(inCard(2, 'Save')?.disabled, true, 'an invalid parameter name is not sent');
    await ui.type(nameField, 'query');
    await ui.click(inCard(2, 'Save'));
    await ui.until(() => daemon.patches.length === 1, 'the parameter patch');

    await ui.click(inCard(4, 'Rename'));
    await ui.type(card(4)?.querySelector<HTMLInputElement>('input[aria-label="Step name"]') ?? null, 'Buy button');
    await ui.click(inCard(4, 'Save'));
    await ui.until(() => daemon.patches.length === 2, 'the rename patch');

    await ui.click(inCard(1, 'Delete step 1'));
    await ui.until(() => daemon.patches.length === 3 && !card(1), 'the step to go');
    assert.equal(learn()?.disabled, true, 'still flagged');

    await ui.click(inCard(3, 'Mask value'));
    await ui.until(() => daemon.patches.length === 4 && !card(3)?.dataset.flagged, 'the flagged step to be masked');
    assert.deepEqual(daemon.patches, [
      [{ op: 'param', step: 2, name: 'query' }],
      [{ op: 'rename', step: 4, name: 'Buy button' }],
      [{ op: 'drop', step: 1 }],
      [{ op: 'mask', step: 3 }],
    ]);
    assert.equal(card(3)?.textContent?.includes(KEY), false, 'the masked value is gone from the screen');
    assert.match(card(2)?.textContent ?? '', /Parameter: query/);
    assert.equal(learn()?.disabled, false, 'every flagged step settled: Learn is on');
    assert.ok(!document.querySelector('[data-flagged-notice]'));
    assert.equal(ui.calls.some((call) => call.url.endsWith('/learn')), false);
  } finally { await ui.cleanup(); }
});

test('Keep as is settles a flagged step too', async () => {
  const daemon = fakeDaemon();
  const ui = await browserRecordingDom({ owner: true, route: daemon.route });
  try {
    await openReview(ui);
    await ui.click(inCard(3, 'Keep as is'));
    await ui.until(() => daemon.patches.length === 1 && ui.button('Learn')?.disabled === false, 'Learn to turn on');
    assert.deepEqual(daemon.patches, [[{ op: 'unmask', step: 3 }]]);
    assert.match(card(3)?.textContent ?? '', new RegExp(KEY), 'kept: the owner said it is not a secret');
  } finally { await ui.cleanup(); }
});

test('Learn asks autoSubmit (off), opens the mission, and the skill is attached only on the operator\'s click', async () => {
  const daemon = fakeDaemon();
  daemon.createSkill('browser-buy-shoes');
  const ui = await browserRecordingDom({ owner: true, route: daemon.route });
  const navigations: string[] = [];
  const listen = (event: Event) => navigations.push((event as CustomEvent<string>).detail);
  window.addEventListener('rooks:navigate', listen);
  try {
    await openReview(ui);
    await ui.click(inCard(3, 'Mask value'));
    await ui.until(() => ui.button('Learn')?.disabled === false, 'Learn to turn on');
    await ui.click(ui.button('Learn'));
    const autoSubmit = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.equal(autoSubmit?.checked, false, 'autoSubmit is off unless chosen');
    await ui.click(ui.button('Start learning'));
    await ui.until(() => navigations.length === 1, 'the mission to open');
    const learn = ui.calls.find((call) => call.url.endsWith('/learn'));
    assert.deepEqual([learn?.method, learn?.body], ['POST', { autoSubmit: false, agent: 'shopper' }]);
    assert.equal(navigations[0], '/chat?agent=shopper&mission=m-1');

    await ui.until(() => !!document.querySelector('[data-skill]'), 'the attach card');
    assert.deepEqual(Array.from(document.querySelectorAll<HTMLElement>('[data-skill]')).map((node) => node.dataset.skill), ['browser-buy-shoes'], 'the skill the recording names, not another recent browser- skill');
    assert.match(document.querySelector('[data-skill]')?.textContent ?? '', /Buy running shoes/);
    assert.ok(ui.button('Attach to shopper'));
    assert.ok(!ui.button('Attach to elsewhere'), 'only agents that use this browser profile');
    assert.equal(ui.calls.some((call) => call.url.includes('/api/ui/agents/') && call.method === 'PATCH'), false, 'nothing attached by itself');

    await ui.click(ui.button('Attach to shopper'));
    await ui.until(() => !!ui.button('Attached to shopper'), 'the attachment');
    const attach = ui.calls.find((call) => call.url === '/api/ui/agents/shopper/config');
    assert.deepEqual([attach?.method, attach?.body], ['PATCH', { skills: ['notes', 'browser-buy-shoes'] }]);
    assert.equal(ui.button('Attached to shopper')?.disabled, true);
  } finally {
    window.removeEventListener('rooks:navigate', listen);
    await ui.cleanup();
  }
});

test('Learn offers only the agents the daemon says can run without a shell, and none means no Start', async () => {
  const daemon = fakeDaemon();
  daemon.offerAgents([{ name: 'reader', main: false }, { name: 'shopper', main: false }]);
  const ui = await browserRecordingDom({ owner: true, route: daemon.route });
  try {
    await openReview(ui);
    await ui.click(inCard(3, 'Mask value'));
    await ui.until(() => ui.button('Learn')?.disabled === false, 'Learn to turn on');
    await ui.click(ui.button('Learn'));
    await ui.until(() => !!document.querySelector('select'), 'the agent picker');
    const select = document.querySelector<HTMLSelectElement>('select')!;
    assert.deepEqual(Array.from(select.options).map((option) => option.value), ['reader', 'shopper'], 'never `elsewhere`, which the daemon did not offer');
    select.value = 'shopper';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await ui.click(ui.button('Start learning'));
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/learn')), 'the learn request');
    assert.deepEqual(ui.calls.find((call) => call.url.endsWith('/learn'))?.body, { autoSubmit: false, agent: 'shopper' });
  } finally { await ui.cleanup(); }

  const empty = fakeDaemon();
  empty.offerAgents([]);
  const none = await browserRecordingDom({ owner: true, route: empty.route });
  try {
    await openReview(none);
    await none.click(inCard(3, 'Mask value'));
    await none.until(() => none.button('Learn')?.disabled === false, 'Learn to turn on');
    await none.click(none.button('Learn'));
    await none.until(() => !!document.querySelector('[data-no-safe-agent]'), 'the notice');
    assert.match(document.querySelector('[data-no-safe-agent]')?.textContent ?? '', /without a shell or file writes/);
    assert.equal(none.button('Start learning')?.disabled, true);
    assert.equal(none.calls.some((call) => call.url.endsWith('/learn')), false, 'nothing is started');
  } finally { await none.cleanup(); }
});

test('without a learnedSkillId there is no attach card, even with recent browser- skills; it comes once the recording names one', async () => {
  const daemon = fakeDaemon();
  const ui = await browserRecordingDom({ owner: true, route: daemon.route });
  try {
    await openReview(ui);
    await ui.click(inCard(3, 'Mask value'));
    await ui.until(() => ui.button('Learn')?.disabled === false, 'Learn to turn on');
    await ui.click(ui.button('Learn'));
    await ui.click(ui.button('Start learning'));
    await ui.until(() => !!ui.button('Refresh'), 'the no-skill notice');
    assert.match(document.querySelector('[data-learned-card]')?.textContent ?? '', /No skill written by this mission was found/);
    assert.ok(!document.querySelector('[data-skill]'), 'no guess from the browser- prefix and the date');
    assert.equal(ui.calls.some((call) => call.url === '/api/ui/skills'), false);

    daemon.createSkill('browser-buy-shoes');
    await ui.click(ui.button('Refresh'));
    await ui.until(() => !!document.querySelector('[data-skill]'), 'the attach card');
    assert.deepEqual(Array.from(document.querySelectorAll<HTMLElement>('[data-skill]')).map((node) => node.dataset.skill), ['browser-buy-shoes']);
    assert.ok(ui.button('Attach to shopper'));
  } finally { await ui.cleanup(); }
});

test('a Stop the daemon answers with an already saved recording opens that recording\'s review directly', async () => {
  const daemon = fakeDaemon();
  const ui = await browserRecordingDom({
    owner: true,
    route: (call) => {
      if (call.url.endsWith('/p1/recording/stop')) {
        return Response.json({ recording: { id: ID, profileId: 'p1', title: 'shop.example', startUrl: '', steps: 4, flagged: 1, truncated: false,
          stoppedReason: 'idle', createdAt: 1, updatedAt: 1, status: 'draft', learnMissionId: null, stepsAvailable: true }, alreadySaved: true });
      }
      return daemon.route(call);
    },
  });
  try {
    // The pill still showed the recording: an agent's stop had made the daemon collect it meanwhile.
    await ui.browse({ status: status({ active: true, steps: 4 }) });
    await ui.until(() => !!ui.button('Stop'), 'the owner\'s Stop');
    await ui.click(ui.button('Stop'));
    await ui.until(() => document.querySelectorAll('[data-step]').length === 4, 'the review of the saved recording');
    assert.match(document.querySelector('[data-already-saved]')?.textContent ?? '', /already ended on its own and been saved/);
    assert.equal(document.querySelector('[data-already-saved]')?.getAttribute('role'), 'status');
    assert.ok(!document.querySelector('[role="alert"]'), 'no error shown');
    assert.ok(ui.calls.some((call) => call.method === 'GET' && call.url === `/api/ui/native-browser/recordings/${ID}`), 'the steps come from the masked read, not from the Stop');

    await ui.click(ui.button('All recordings'));
    await ui.until(() => !document.querySelector('[data-step]'), 'the list');
    await ui.click(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-browser-recording-review] li button'))[0]);
    await ui.until(() => document.querySelectorAll('[data-step]').length === 4, 'the same recording again');
    assert.ok(!document.querySelector('[data-already-saved]'), 'the notice belongs to that Stop only');
  } finally { await ui.cleanup(); }
});

test('a viewer who does not own the profile gets no review', async () => {
  const ui = await browserRecordingDom({ owner: false });
  try {
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/p1/recordings')), 'the owner check');
    assert.ok(!ui.button('Recordings'));
    assert.equal(ui.calls.some((call) => call.url.includes('/recordings/')), false, 'no recording is ever read');
  } finally { await ui.cleanup(); }
});
