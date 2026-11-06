import assert from 'node:assert/strict';
import test from 'node:test';
import { answerConfirmsForTests } from '@/components/confirm-dialog/confirm-dialog-context';

test('built-in role editor sends only the prompt, retains failed drafts and resets explicitly', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event'] as const) install(key, dom.window[key]);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { RoleManager } = await import('../components/role-manager');
  const { getLocale, setLocale } = await import('./i18n');
  await import('./i18n-test-locales');
  const locale = getLocale();
  setLocale('en');
  const requests: Array<{ url: string; method?: string; body: unknown }> = [];
  let fail = false;
  let confirmReset = false;
  let changed = 0;
  answerConfirmsForTests(() => confirmReset);
  install('fetch', async (input: string, init: RequestInit) => {
    requests.push({ url: input, method: init.method, body: JSON.parse(String(init.body)) });
    return Response.json(fail ? { error: 'Try again' } : {}, { status: fail ? 400 : 200 });
  });
  const role = { id: 'coder', label: 'Coder', iconName: 'Code2', iconSvg: '<path/>', color: '#123456', default_directives: 'Saved override', default_model: 'opus', default_permission_mode: 'auto', builtin: true, directives_overridden: true };
  const root = createRoot(document.getElementById('root')!);
  const click = async (label: string) => React.act(async () => {
    const button = Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label);
    assert.ok(button, label);
    button.click();
  });
  try {
    await React.act(async () => { root.render(React.createElement(RoleManager, { roles: [role], onChanged: () => { changed++; } })); });
    await click('Manage roles');
    assert.match(document.body.textContent!, /Modified/);
    await click('Edit coder');
    assert.ok(Array.from(document.querySelectorAll('input')).every((input) => input.disabled));
    assert.ok(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="combobox"]')).every((input) => input.disabled));
    const textarea = document.querySelector('textarea')!;
    assert.equal(textarea.value, 'Saved override');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'New prompt');
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    fail = true;
    await click('Save');
    assert.equal(document.querySelector('textarea')?.value, 'New prompt');
    assert.equal(changed, 0);
    fail = false;
    await click('Save');
    assert.deepEqual(requests.at(-1), { url: '/api/ui/agent-roles/coder', method: 'PUT', body: { default_directives: 'New prompt' } });
    assert.equal(changed, 1);
    await click('Edit coder');
    await click('Reset prompt');
    assert.equal(requests.length, 2, 'cancelling reset sends nothing');
    confirmReset = true;
    await click('Reset prompt');
    assert.deepEqual(requests.at(-1)?.body, { reset_directives: true });
    assert.equal(changed, 2);
  } finally {
    await React.act(async () => { root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    setLocale(locale);
    answerConfirmsForTests(null);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
