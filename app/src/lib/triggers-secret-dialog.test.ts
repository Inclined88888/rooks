/**
 * Triggers page windows (TODO #539): "copied" is said only once the clipboard
 * took the value, a secret the clipboard refused is shown to be copied by hand
 * rather than lost, and every window traps focus and closes on Escape — not on
 * a stray click beside it. Escape on a modified trigger draft asks before
 * throwing it away (TODO #602).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const SECRET = 'whsec_' + 'k'.repeat(32);

test('trigger windows: honest copy, focus trap, Escape', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<button id="opener">open</button><div id="root"></div><div id="toasts"></div>', { url: 'http://localhost/triggers', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'FocusEvent', 'MouseEvent', 'PointerEvent', 'CustomEvent', 'DocumentFragment', 'NodeFilter', 'HTMLInputElement', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    install(key, key === 'window' ? dom.window : typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof dom.window.matchMedia;
  // jsdom has no execCommand: the textarea fallback of copyToClipboard fails,
  // so a refused writeText is a copy that failed for good.
  let clipboard: { writeText: (text: string) => Promise<void> } = { writeText: async () => {} };
  Object.defineProperty(dom.window.navigator, 'clipboard', { get: () => clipboard, configurable: true });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  // The components load sonner as CommonJS: its Toaster must be that very
  // instance, or it listens to a toast queue nobody writes to.
  const { Toaster } = createRequire(import.meta.url)('sonner') as typeof import('sonner');
  const { SecretDialog } = await import('../plugins-client/triggers/secret-dialog');
  const { JournalDialog } = await import('../plugins-client/triggers/test-and-journal');
  const { TriggerEditor } = await import('../plugins-client/triggers/trigger-editor');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === '/api/ui/triggers/tr-1/deliveries?limit=50') return Response.json({ deliveries: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  const toasts = createRoot(document.getElementById('toasts')!);
  const root = createRoot(document.getElementById('root')!);
  const settle = async () => { await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const button = (label: RegExp) => Array.from(document.querySelectorAll('button')).find((b) => label.test(b.textContent ?? '') || label.test(b.getAttribute('aria-label') ?? ''));
  const click = async (el: Element | undefined | null) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
    await settle();
  };
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const toastText = () => document.getElementById('toasts')?.textContent ?? '';
  let closed = 0;
  let shown = 0;
  // A fresh key per showing: each case starts from a never-copied dialog.
  const showSecret = async () => {
    closed = 0;
    shown += 1;
    await React.act(async () => root.render(React.createElement(SecretDialog, {
      key: shown, secret: SECRET, scheme: 'generic', url: 'http://localhost/api/triggers/hooks/x', onClose: () => { closed += 1; },
    })));
    await settle();
  };

  try {
    // Toasts never expire here (TODO #800). An expiring toast arms a 200 ms
    // removal timer that unmounting does not cancel; when the file runs past
    // the 4 s lifetime (under load), that timer can land after the globals are
    // restored, and the setState it makes reads `window.event`.
    await React.act(async () => toasts.render(React.createElement(Toaster, { duration: Infinity })));

    await suite.test('"copied" waits for the clipboard, and the secret stays out of the page', async () => {
      let release: () => void = () => {};
      const copied: string[] = [];
      clipboard = { writeText: (text) => new Promise<void>((resolve) => { release = () => { copied.push(text); resolve(); }; }) };
      await showSecret();
      await click(button(/^Copy the secret$/));
      assert.doesNotMatch(toastText(), /Secret copied/, 'nothing announced while the clipboard has not answered');
      await React.act(async () => { release(); });
      await settle();
      assert.deepEqual(copied, [SECRET]);
      assert.match(toastText(), /Secret copied/);
      assert.equal(document.body.innerHTML.includes(SECRET), false, 'a copied secret is never rendered');
    });

    await suite.test('a refused copy says so and shows the secret, selected, instead of losing it', async () => {
      clipboard = { writeText: async () => { throw new Error('NotAllowedError'); } };
      await showSecret();
      assert.equal(document.body.innerHTML.includes(SECRET), false);
      await click(button(/^Copy the secret$/));
      assert.match(toastText(), /Copy failed/);
      const field = document.querySelector<HTMLInputElement>('[data-testid="trigger-secret-revealed"]');
      assert.ok(field, 'the secret is offered to be copied by hand');
      assert.equal(field.value, SECRET);
      assert.equal(field.readOnly, true);
      assert.equal(document.activeElement, field, 'focused, ready for Ctrl+C');
      assert.equal(field.selectionStart, 0);
      assert.equal(field.selectionEnd, SECRET.length);
      assert.equal(closed, 0);
    });

    await suite.test('the address copy reports a failure too', async () => {
      clipboard = { writeText: async () => { throw new Error('NotAllowedError'); } };
      await showSecret();
      await click(button(/^Copy the webhook address$/));
      assert.match(toastText(), /Copy failed: the clipboard refused it/);
    });

    await suite.test('focus is trapped in the window, which is labelled by its title', async () => {
      clipboard = { writeText: async () => {} };
      await showSecret();
      const box = dialog();
      assert.ok(box, 'a dialog');
      assert.equal(box.getAttribute('aria-modal') ?? 'true', 'true');
      const title = document.getElementById(box.getAttribute('aria-labelledby') ?? '');
      assert.match(title?.textContent ?? '', /Webhook secret/);
      assert.ok(box.contains(document.activeElement), 'focus moves into the window on open');
      const opener = document.getElementById('opener')!;
      await React.act(async () => { opener.focus(); });
      assert.ok(box.contains(document.activeElement), 'focus cannot leave the window');
    });

    await suite.test('a click beside the secret window does not close it', async () => {
      await showSecret();
      const outside = document.getElementById('opener')!;
      await React.act(async () => {
        outside.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        outside.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await settle();
      assert.equal(closed, 0);
    });

    const escape = async () => {
      await React.act(async () => { document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
      await settle();
    };

    await suite.test('Escape does not throw away a secret nobody copied', async () => {
      clipboard = { writeText: async () => { throw new Error('NotAllowedError'); } };
      await showSecret();
      await escape();
      assert.equal(closed, 0, 'not copied yet');
      await click(button(/^Copy the secret$/));
      await escape();
      assert.equal(closed, 0, 'the copy failed: still nothing kept');
      assert.ok(dialog(), 'the window is still open');
      await click(button(/^I copied it$/));
      assert.equal(closed, 1, 'the explicit button still closes it');
    });

    await suite.test('Escape closes the secret window once it was copied', async () => {
      clipboard = { writeText: async () => {} };
      await showSecret();
      await click(button(/^Copy the secret$/));
      await escape();
      assert.equal(closed, 1);
    });

    await suite.test('Escape closes the journal window too', async () => {
      let journalClosed = 0;
      const trigger = {
        id: 'tr-1', name: 'Discord bugs', slug: 'discord-bugs', source: 'webhook', enabled: true, config: { auth: 'generic' },
        filter: null, actions: [], created_by: 'user', creator_agent: null, has_secret: true,
        url: '/api/triggers/hooks/discord-bugs', last_run_at: null, next_run_at: null, created_at: 1, updated_at: 1,
      } as const;
      await React.act(async () => root.render(React.createElement(JournalDialog, {
        trigger: trigger as unknown as Parameters<typeof JournalDialog>[0]['trigger'], onClose: () => { journalClosed += 1; },
      })));
      await settle();
      assert.match(dialog()?.textContent ?? '', /Discord bugs/);
      assert.ok(dialog()!.contains(document.activeElement));
      await escape();
      assert.equal(journalClosed, 1);
    });

    let editorClosed = 0;
    let editors = 0;
    const existing = {
      id: 'tr-2', name: 'Nightly digest', slug: null, source: 'schedule', enabled: true, config: { cron: '0 2 * * *' },
      filter: null, actions: [{ type: 'todo', text: 'Digest' }], created_by: 'user', creator_agent: null, has_secret: false,
      url: null, last_run_at: null, next_run_at: null, created_at: 1, updated_at: 1,
    } as const;
    const showEditor = async (trigger: typeof existing | null = null) => {
      editorClosed = 0;
      editors += 1;
      await React.act(async () => root.render(React.createElement(TriggerEditor, {
        key: `editor-${editors}`, source: 'webhook', agents: ['coder'],
        trigger: trigger as unknown as Parameters<typeof TriggerEditor>[0]['trigger'],
        onClose: () => { editorClosed += 1; }, onSaved: () => {},
      })));
      await settle();
    };
    const type = async (selector: string, value: string) => {
      const field = document.querySelector<HTMLInputElement>(selector);
      assert.ok(field, selector);
      await React.act(async () => {
        field.focus();
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    };
    const discardPrompt = () => document.querySelector('[data-testid="trigger-editor-discard"]');
    const nameValue = () => document.querySelector<HTMLInputElement>('#trigger-name')?.value;

    await suite.test('Escape closes an editor nobody touched', async () => {
      await showEditor();
      await escape();
      assert.equal(editorClosed, 1);
      await showEditor(existing);
      await escape();
      assert.equal(editorClosed, 1, 'an existing trigger opened and left as is');
    });

    await suite.test('Escape on a modified draft asks first, and a second Escape keeps editing', async () => {
      await showEditor();
      await type('#trigger-name', 'Discord bugs');
      await escape();
      assert.equal(editorClosed, 0, 'the draft is not thrown away');
      assert.ok(dialog(), 'the editor is still open');
      assert.match(discardPrompt()?.textContent ?? '', /Discard your changes to this trigger\?/);
      assert.equal(document.activeElement?.textContent, 'Keep editing', 'the safe answer has the focus');
      await escape();
      assert.equal(editorClosed, 0, 'Escape twice never discards');
      assert.equal(discardPrompt(), null);
      assert.equal(nameValue(), 'Discord bugs');
      assert.equal(document.activeElement, document.querySelector('#trigger-name'), 'focus back in the field being edited');
    });

    await suite.test('"Keep editing" keeps the draft, "Discard" closes', async () => {
      await showEditor();
      await type('#trigger-name', 'Discord bugs');
      await escape();
      await click(button(/^Keep editing$/));
      assert.equal(editorClosed, 0);
      assert.equal(discardPrompt(), null);
      assert.equal(nameValue(), 'Discord bugs');
      assert.equal(document.activeElement, document.querySelector('#trigger-name'));
      await escape();
      await click(button(/^Discard$/));
      assert.equal(editorClosed, 1);
    });

    await suite.test('typing again answers the question, and a draft put back as it was closes on Escape', async () => {
      await showEditor(existing);
      await type('#trigger-name', 'Nightly digest (team)');
      await escape();
      assert.ok(discardPrompt());
      await type('#trigger-name', 'Nightly digest');
      assert.equal(discardPrompt(), null, 'typing dismisses the question');
      assert.equal(document.activeElement, document.querySelector('#trigger-name'));
      await escape();
      assert.equal(editorClosed, 1, 'nothing left to lose');
    });

    await suite.test('the explicit close button still closes a modified draft at once', async () => {
      await showEditor();
      await type('#trigger-name', 'Discord bugs');
      await click(button(/^Close$/));
      assert.equal(editorClosed, 1);
    });
  } finally {
    await React.act(async () => { root.unmount(); toasts.unmount(); });
    // Radix tears its dialog down on timers (focus return, presence): let
    // them run while jsdom and the globals they reach are still in place.
    for (let tick = 0; tick < 2; tick += 1) await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
});
