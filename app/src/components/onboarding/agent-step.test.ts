/**
 * The agent step, rendered (jsdom) against a fake daemon: the view follows the
 * profile and the switcher changes it, « Create » writes the main agent
 * (name, then one config PATCH) and opens the chat step, a refused name stays
 * on the step, « Customise » opens and closes, and a profile that could not
 * be read says so and can be read again.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendCatalog } from '@/lib/backends';
import {
  agentConfigPath, createMainAgent, loadMainAgent, MAIN_AGENT_NAME_PATH, sheetMcp, sheetSkills,
} from './agent-create';
import { resetOnboardingProfile } from './onboarding-profile';

type Call = { url: string; method: string; body: unknown };
type Answer = (call: Call) => Response | Promise<Response> | undefined;

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    { id: 'claude', label: 'Claude Code', vendor: 'Anthropic', brand: 'claude', defaultModel: 'sonnet', models: [{ slug: 'opus', label: 'Opus' }, { slug: 'sonnet', label: 'Sonnet' }] },
  ],
};

/** The daemon behind the proxy, as the step reads and writes it. `override` answers first. */
function daemon(profile: string | null, override: Answer = () => undefined): { calls: Call[]; fetcher: (input: string, init?: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: async (input, init) => {
      const call: Call = { url: input, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const special = override(call);
      if (special) return special;
      if (call.url === '/api/ui/onboarding/profile') return Response.json({ profile, at: profile ? 1 : null });
      if (call.url === '/api/ui/setup/main-agent') return Response.json({ status: 'pending', available: true, name: '_main', named: false });
      if (call.url === '/api/ui/agents/_main') return Response.json({ name: '_main', backend: 'claude', model: 'opus', skills: ['timon-task'], mcp_servers: ['sentry'], look: null });
      if (call.url.startsWith('/api/ui/backends/catalog')) return Response.json(CATALOG);
      if (call.url.startsWith('/api/ui/backends/provider-clis')) {
        return Response.json({
          backends: [{
            name: 'claude', label: 'Claude Code', brand: 'claude', path: '/bin/claude', bundled: false, signedIn: true,
            installable: false, installCommand: null, installDocs: null, signInCommand: 'claude', signInThen: null,
            seedsMainAgent: true, version: null, latest: null, updateAvailable: false, unsupportedVersion: false,
          }],
          jobs: {}, updateCheck: false,
        });
      }
      if (call.url === '/api/ui/skills') {
        return Response.json({ skills: [{ id: 'timon-task', source: 'timon' }, { id: 'tests', title: 'Tests', source: 'timon' }, { id: 'old', source: 'project', shadowed: true }] });
      }
      if (call.url === '/api/ui/mcp') return Response.json({ servers: [{ id: 'github', name: 'GitHub' }, { id: 'gmail', source: 'claude_ai' }, { id: 'sentry' }] });
      if (call.url === MAIN_AGENT_NAME_PATH) return Response.json({ name: String((call.body as { name: string }).name).toLowerCase() });
      if (call.method === 'PATCH') return Response.json({ ok: true });
      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  };
}

test('the creation names the agent, then writes its config on the name the daemon answered', async () => {
  const d = daemon(null);
  const result = await createMainAgent('Nova', { look: null, directives: 'Never push.' }, d.fetcher);
  assert.deepEqual(result, { ok: true, name: 'nova' });
  assert.deepEqual(d.calls.map((c) => `${c.method} ${c.url}`), ['POST /api/ui/setup/main-agent/name', 'PATCH /api/ui/agents/nova/config']);
  assert.deepEqual(d.calls[0]?.body, { name: 'Nova' });
  assert.deepEqual(d.calls[1]?.body, { look: null, directives: 'Never push.' });
  assert.equal(agentConfigPath('a b'), '/api/ui/agents/a%20b/config');
});

test('a refused name writes nothing else; a refused config is told apart', async () => {
  const taken = daemon(null, (c) => (c.url === MAIN_AGENT_NAME_PATH ? Response.json({ error: 'name_taken' }, { status: 409 }) : undefined));
  assert.deepEqual(await createMainAgent('Nova', { look: null }, taken.fetcher), { ok: false, error: 'name_taken', stage: 'name' });
  assert.equal(taken.calls.length, 1);
  const odd = daemon(null, (c) => (c.url === MAIN_AGENT_NAME_PATH ? Response.json({ error: 'kaboom' }, { status: 500 }) : undefined));
  assert.equal((await createMainAgent('Nova', { look: null }, odd.fetcher)).ok, false);
  const badConfig = daemon(null, (c) => (c.method === 'PATCH' ? Response.json({ error: 'config' }, { status: 400 }) : undefined));
  assert.deepEqual(await createMainAgent('Nova', { look: null }, badConfig.fetcher), { ok: false, error: 'configFailed', stage: 'config', name: 'nova' });
  const again = daemon(null, (c) => (c.method === 'PATCH' ? Response.json({ ok: true }) : undefined));
  assert.deepEqual(await createMainAgent('Nova', { look: null }, again.fetcher, { name: 'nova' }), { ok: true, name: 'nova' });
  assert.equal(again.calls.some((c) => c.method === 'POST'), false, 'the named agent is not renamed again');
  const renamed = daemon(null, (c) => (c.method === 'PATCH' ? Response.json({ ok: true }) : undefined));
  assert.deepEqual(await createMainAgent('Other', { look: null }, renamed.fetcher, { name: 'nova' }), { ok: true, name: 'nova' });
  assert.equal(renamed.calls.some((c) => c.method === 'POST'), false, 'a different name after a failed save does not rename again');
});

test('the main agent is read as it stands; an unreachable daemon is an empty agent', async () => {
  const state = await loadMainAgent(daemon(null).fetcher);
  assert.deepEqual(state, { name: '_main', named: false, backend: 'claude', model: 'opus', skills: ['timon-task'], mcpServers: ['sentry'], look: null, role: null });
  const down = await loadMainAgent(async () => { throw new Error('offline'); });
  assert.equal(down.name, null);
});

test('the sheet offers the person\'s skills and opt-in MCP servers, not the product\'s own', () => {
  assert.deepEqual(sheetSkills([{ id: 'timon-task' }, { id: 'tests', title: 'Tests' }, { id: 'x', shadowed: true }, { nope: 1 }]), [{ id: 'tests', label: 'Tests' }]);
  assert.deepEqual(sheetMcp([{ id: 'github', name: 'GitHub' }, { id: 'gmail', source: 'claude_ai' }, { id: 'local', source: 'claude_cli' }]), [{ id: 'github', label: 'GitHub' }]);
  assert.deepEqual(sheetSkills('nope'), []);
});

/* ---------- The step, rendered ---------- */

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding?step=agent', pretendToBeVisual: true });
  // Reduced motion: no live mascot loop, and the step moves on without waiting for the jump.
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver', 'Event', 'KeyboardEvent', 'getComputedStyle', 'XMLSerializer']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  try {
    return await run(dom as unknown as Dom, React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

type Rendered = { host: HTMLElement; calls: Call[]; nexts: () => number; react: typeof import('react'); dom: Dom };

async function renderStep(profile: string | null, run: (r: Rendered) => Promise<void>, override?: Answer): Promise<void> {
  await withDom(async (dom, React) => {
    resetOnboardingProfile();
    const { createRoot } = await import('react-dom/client');
    const { OnboardingProvider } = await import('./onboarding-context');
    const { AgentStep } = await import('./steps/agent');
    const fake = daemon(profile, override);
    const savedFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fake.fetcher(String(input), init)) as typeof fetch;
    let nexts = 0;
    const nav = {
      step: 'agent' as const, direction: 1 as const,
      next: () => { nexts += 1; }, back: () => undefined, goTo: () => undefined,
      setLanguage: async (tag: string) => tag, setBackHandler: () => undefined,
    };
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    try {
      await React.act(async () => { root.render(React.createElement(OnboardingProvider, { value: nav }, React.createElement(AgentStep))); });
      await settle(React);
      await run({ host, calls: fake.calls, nexts: () => nexts, react: React, dom });
    } finally {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = savedFetch;
      resetOnboardingProfile();
    }
  });
}

const settle = (react: typeof import('react'), ms = 20): Promise<void> => react.act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const q = <T extends Element = HTMLElement>(host: HTMLElement, selector: string): T => {
  const el = host.querySelector<T>(selector) ?? document.querySelector<T>(selector);
  assert.ok(el, `${selector} is on screen`);
  return el;
};
const click = async (r: Rendered, selector: string): Promise<void> => {
  await r.react.act(async () => { q<HTMLElement>(r.host, selector).click(); });
  await settle(r.react);
};
const patchOf = (calls: readonly Call[]): Record<string, unknown> | undefined => calls.find((c) => c.method === 'PATCH')?.body as Record<string, unknown> | undefined;

test('each profile opens its view, with no view switcher', async () => {
  for (const [profile, view] of [['developer', 'sheet'], ['automation', 'interview'], ['beginner', 'templates']] as const) {
    await renderStep(profile, async (r) => {
      assert.equal(q(r.host, '[data-onboarding-step="agent"]').getAttribute('data-agent-view'), view);
      assert.equal(r.host.querySelector('[data-view-switcher]'), null);
      assert.equal(r.host.querySelector('[data-view]'), null);
    });
  }
});

test('templates: « Create » waits for a profile, then writes the agent and opens the chat', async () => {
  await renderStep('beginner', async (r) => {
    assert.ok((q<HTMLInputElement>(r.host, '[data-agent-name]').value).length > 0, 'a name is drawn');
    assert.equal(q<HTMLButtonElement>(r.host, '[data-create]').disabled, false, 'Continue is available before a profile is picked');
    await click(r, '[data-template="assist"]');
    assert.equal(q(r.host, '[data-role-pill]').textContent, 'Personal assistant');
    assert.deepEqual(Array.from(r.host.querySelectorAll('[data-cap]')).map((el) => el.getAttribute('data-cap')), ['base', 'mail', 'agenda']);
    assert.equal(q<HTMLButtonElement>(r.host, '[data-create]').disabled, false);
    const name = q<HTMLInputElement>(r.host, '[data-agent-name]').value;
    await click(r, '[data-create]');
    await settle(r.react, 40);
    const named = r.calls.find((c) => c.url === MAIN_AGENT_NAME_PATH);
    assert.deepEqual(named?.body, { name });
    const patch = patchOf(r.calls);
    assert.equal(patch?.look, null);
    assert.match(String(patch?.directives), /email/);
    assert.equal(r.calls.find((c) => c.method === 'PATCH')?.url, `/api/ui/agents/${encodeURIComponent(name.toLowerCase())}/config`);
    assert.equal(r.nexts(), 1, 'the chat step opens');
  });
});

test('a refused name is said on the step, which stays', async () => {
  await renderStep('beginner', async (r) => {
    await click(r, '[data-template="dev"]');
    await click(r, '[data-create]');
    await settle(r.react, 40);
    assert.ok(q(r.host, '[data-create-hint][role="alert"]').textContent);
    assert.equal(patchOf(r.calls), undefined, 'nothing else written');
    assert.equal(r.nexts(), 0);
    assert.equal(q<HTMLButtonElement>(r.host, '[data-create]').disabled, false, 'it can be tried again');
  }, (c) => (c.url === MAIN_AGENT_NAME_PATH ? Response.json({ error: 'name_taken' }, { status: 409 }) : undefined));
});

test('sheet: line of work, exact permission mode with its warning, the daemon\'s lists, all written', async () => {
  await renderStep('developer', async (r) => {
    assert.equal(q(r.host, '[data-role="orchestrator"]').getAttribute('aria-pressed'), 'true', 'the sheet opens on the pilot');
    assert.equal(r.host.querySelector('[data-role]')?.getAttribute('data-role'), 'orchestrator', 'first of the list');
    assert.equal(q(r.host, '[data-role-pill]').textContent, 'Orchestrator / pilot');
    assert.match(q(r.host, '[data-role-hint]').textContent ?? '', /main agent/);
    await click(r, '[data-role="review"]');
    assert.equal(q(r.host, '[data-role-pill]').textContent, 'Reviewer');
    await click(r, '[data-tab="engine"]');
    // The product's model picker, not a list of the step's own.
    const sonnet = Array.from(r.host.querySelectorAll<HTMLButtonElement>('[data-picker-row]')).find((b) => b.textContent?.includes('Sonnet'));
    assert.ok(sonnet, 'the catalogue\'s models are offered');
    await r.react.act(async () => { sonnet.click(); });
    await settle(r.react);
    assert.match(q(r.host, '[data-model]').getAttribute('data-model') ?? '', /claude\/sonnet/, 'the card names the picked model');
    await click(r, '[data-tab="perms"]');
    assert.deepEqual(Array.from(r.host.querySelectorAll('[data-permission]')).map((el) => el.getAttribute('data-permission')), ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
    assert.ok(!r.host.querySelector('[data-bypass-warning]'));
    await click(r, '[data-permission="bypassPermissions"]');
    assert.ok(q(r.host, '[data-bypass-warning]'));
    await click(r, '[data-tab="tools"]');
    assert.deepEqual(Array.from(r.host.querySelectorAll('[data-skill]')).map((el) => el.getAttribute('data-skill')), ['tests']);
    assert.deepEqual(Array.from(r.host.querySelectorAll('[data-mcp]')).map((el) => el.getAttribute('data-mcp')), ['github', 'sentry']);
    assert.equal(q(r.host, '[data-mcp="sentry"]').getAttribute('aria-pressed'), 'true', 'what the agent had starts checked');
    await click(r, '[data-skill="tests"]');
    await click(r, '[data-mcp="github"]');
    await click(r, '[data-create]');
    await settle(r.react, 40);
    const patch = patchOf(r.calls);
    assert.ok(patch && !('role' in patch), 'the main agent stays the pilot: no role written');
    assert.match(String(patch?.directives), /^Main line of work: reviewing/);
    assert.equal(patch?.permission_mode, 'bypassPermissions');
    assert.equal(patch?.backend, 'claude');
    assert.equal(patch?.model, 'sonnet');
    assert.deepEqual(patch?.skills, ['timon-task', 'tests'], 'the product\'s own skill is kept');
    assert.deepEqual(patch?.mcp_servers, ['sentry', 'github']);
    assert.equal(patch?.look, null);
    assert.equal(r.nexts(), 1);
  });
});

test('the sheet writes no model when no AI tool is installed', async () => {
  await renderStep('developer', async (r) => {
    await click(r, '[data-tab="engine"]');
    const sonnet = Array.from(r.host.querySelectorAll<HTMLButtonElement>('[data-picker-row]')).find((b) => b.textContent?.includes('Sonnet'));
    assert.ok(sonnet);
    await r.react.act(async () => { sonnet.click(); });
    await click(r, '[data-create]');
    await settle(r.react, 40);
    const patch = patchOf(r.calls);
    assert.equal(patch?.backend, undefined);
    assert.equal(patch?.model, undefined);
    assert.equal(r.host.querySelector('[data-model]'), null);
  }, (c) => (c.url.startsWith('/api/ui/backends/provider-clis')
    ? Response.json({ backends: [], jobs: {}, updateCheck: false })
    : undefined));
});

test('a Continue before the provider list returns keeps the chosen model', async () => {
  await renderStep('developer', async (r) => {
    await click(r, '[data-tab="engine"]');
    const sonnet = Array.from(r.host.querySelectorAll<HTMLButtonElement>('[data-picker-row]')).find((b) => b.textContent?.includes('Sonnet'));
    assert.ok(sonnet);
    await r.react.act(async () => { sonnet.click(); });
    await click(r, '[data-create]');
    const patch = patchOf(r.calls);
    assert.equal(patch?.backend, 'claude');
    assert.equal(patch?.model, 'sonnet');
  }, (c) => (c.url.startsWith('/api/ui/backends/provider-clis')
    ? new Promise((resolve) => { setTimeout(() => resolve(Response.json({ backends: [], jobs: {}, updateCheck: false })), 800); })
    : undefined));
});

test('Ollama and an API-key profile keep the chosen model', async () => {
  await renderStep('developer', async (r) => {
    await click(r, '[data-tab="engine"]');
    const sonnet = Array.from(r.host.querySelectorAll<HTMLButtonElement>('[data-picker-row]')).find((b) => b.textContent?.includes('Sonnet'));
    assert.ok(sonnet);
    await r.react.act(async () => { sonnet.click(); });
    await click(r, '[data-create]');
    const patch = patchOf(r.calls);
    assert.equal(patch?.backend, 'claude');
    assert.equal(patch?.model, 'sonnet');
    assert.ok(r.host.querySelector('[data-model]'));
  }, (c) => {
    if (c.url.startsWith('/api/ui/backends/provider-clis')) {
      return Response.json({
        backends: [{
          name: 'claude', label: 'Claude Code', brand: 'claude', path: null, bundled: false, signedIn: null,
          installable: false, installCommand: null, installDocs: null, signInCommand: 'claude', signInThen: null,
          seedsMainAgent: true, version: null, latest: null, updateAvailable: false, unsupportedVersion: false,
        }],
        jobs: {}, updateCheck: false,
      });
    }
    if (c.url.startsWith('/api/ui/backends/catalog')) {
      return Response.json({
        defaultBackend: 'claude',
        backends: [
          CATALOG.backends[0],
          { id: 'ollama-cloud', label: 'Ollama Cloud', brand: 'ollama', defaultModel: 'llama', models: [{ slug: 'llama', label: 'Llama' }] },
        ],
      });
    }
    return undefined;
  });
});

test('a failed config save is retried on the same agent', async () => {
  let patches = 0;
  await renderStep('beginner', async (r) => {
    await click(r, '[data-create]');
    await settle(r.react, 40);
    assert.equal(r.nexts(), 0);
    assert.equal(r.calls.filter((c) => c.url === MAIN_AGENT_NAME_PATH).length, 1);
    await click(r, '[data-create]');
    await settle(r.react, 40);
    assert.equal(r.calls.filter((c) => c.url === MAIN_AGENT_NAME_PATH).length, 1, 'the second Continue does not rename again');
    assert.equal(r.nexts(), 1);
  }, (c) => {
    if (c.method !== 'PATCH') return undefined;
    patches += 1;
    return patches === 1 ? Response.json({ error: 'config' }, { status: 400 }) : undefined;
  });
});

test('after a failed save, Continue with defaults leaves the name and skips another write', async () => {
  await renderStep('beginner', async (r) => {
    await click(r, '[data-create]');
    await settle(r.react, 40);
    assert.ok(r.host.querySelector('[data-continue-defaults]'), 'a failed save can continue with defaults');
    assert.equal(q<HTMLInputElement>(r.host, '[data-agent-name]').disabled, true, 'the name stays after the rename');
    await click(r, '[data-create]');
    await settle(r.react, 40);
    assert.equal(r.calls.filter((c) => c.url === MAIN_AGENT_NAME_PATH).length, 1);
    assert.equal(r.nexts(), 0);
    await click(r, '[data-continue-defaults]');
    assert.equal(r.nexts(), 1);
    assert.equal(r.calls.filter((c) => c.method === 'PATCH').length, 2, 'defaults do not write the config again');
    assert.equal(r.calls.filter((c) => c.url === MAIN_AGENT_NAME_PATH).length, 1);
  }, (c) => (c.method === 'PATCH' ? Response.json({ error: 'config' }, { status: 400 }) : undefined));
});

test('Continue is on the step, and the mascot styler is not', async () => {
  await renderStep('developer', async (r) => {
    assert.equal(r.host.querySelector('[data-customise]'), null);
    assert.equal(r.host.querySelector('[data-look-styler]'), null);
    assert.match(q(r.host, '[data-create]').textContent ?? '', /Continue/);
    assert.equal(q<HTMLButtonElement>(r.host, '[data-create]').disabled, false);
  });
});

test('interview: five questions, answered ones reopen, then « Create » writes the autonomy', async () => {
  await renderStep('automation', async (r) => {
    assert.equal(q<HTMLButtonElement>(r.host, '[data-create]').disabled, true);
    await click(r, '[data-mission="mail"]');
    await click(r, '[data-next-question]');
    assert.equal(q(r.host, '[data-tool="gmail"]').getAttribute('aria-pressed'), 'true', 'the tool its mission needs');
    await click(r, '[data-next-question]');
    await click(r, '[data-next-question]');
    await click(r, '[data-autonomy="report"]');
    await click(r, '[data-next-question]');
    await click(r, '[data-edit-question="1"]');
    assert.equal(q(r.host, '[data-question]').getAttribute('data-question'), '1', 'a past answer reopens');
    for (let i = 0; i < 5; i += 1) await click(r, '[data-next-question]');
    assert.ok(!r.host.querySelector('[data-question]'));
    await click(r, '[data-create]');
    await settle(r.react, 40);
    const patch = patchOf(r.calls);
    assert.equal(patch?.permission_mode, 'auto');
    assert.match(String(patch?.directives), /Gmail/);
    assert.equal(patch?.look, null);
  });
});

test('a profile that could not be read says so, and « Retry » reads it again', async () => {
  let up = false;
  await renderStep(null, async (r) => {
    assert.equal(q(r.host, '[data-onboarding-step="agent"]').getAttribute('data-agent-view'), 'templates');
    assert.ok(q(r.host, '[data-profile-error]'));
    up = true;
    await click(r, '[data-profile-error] button');
    await settle(r.react, 40);
    assert.ok(!r.host.querySelector('[data-profile-error]'));
    assert.equal(q(r.host, '[data-onboarding-step="agent"]').getAttribute('data-agent-view'), 'sheet');
  }, (c) => (c.url === '/api/ui/onboarding/profile'
    ? (up ? Response.json({ profile: 'developer', at: 1 }) : Response.json({ error: 'unreachable' }, { status: 502 }))
    : undefined));
});

