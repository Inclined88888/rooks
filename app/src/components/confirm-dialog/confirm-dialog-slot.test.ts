/**
 * The confirmation slot `confirm.dialog` (TODO #781): declared at boot, the
 * product's dialog is painted while nothing claims it, questions wait in line,
 * Escape answers no, a plugin loaded through the real client loader takes its
 * place and answers through the host, and its removal gives the product's
 * dialog back. Without a host, nothing is confirmed. The
 * `examples/plugin-confirm-dialog` template does the same with the SDK alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
import { waitUntil } from '../../lib/test-wait';

const ACME = { id: 'acme-confirm', state: 'active', version: '1.0.0', signature: { hash: 'h1' }, client: { url: '/x', rev: '1', slots: ['confirm.dialog'] } };

async function mountConfirmHost(plugins: unknown[] = [], { outer = false }: { outer?: boolean } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent',
    'PointerEvent', 'FocusEvent', 'DocumentFragment', 'ShadowRoot', 'sessionStorage', 'localStorage'] as const) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) install(key, value);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string) => {
    const url = String(input);
    if (url === '/api/ui/plugins' || url === '/api/ui/plugins/local') return Response.json({ plugins });
    return Response.json({}, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const loader = await import('@/lib/plugin-host/loader');
  loader.resetClientPluginsForTests();
  const { ConfirmDialogHost, ProductConfirmDialog } = await import('./confirm-dialog');
  const context = await import('./confirm-dialog-context');

  const { Dialog, DialogContent, DialogTitle } = await import('@/components/ui/dialog');
  const outerOpen = { current: outer };
  // A modal of the product (the agent editor, a project form) that asks from inside.
  function Outer() {
    const [open, setOpen] = React.useState(true);
    outerOpen.current = open;
    return React.createElement(Dialog, { open, onOpenChange: setOpen },
      React.createElement(DialogContent, { 'aria-describedby': undefined, ...{ 'data-outer': '' } },
        React.createElement(DialogTitle, null, 'Agent editor')));
  }
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(React.Fragment, null, outer ? React.createElement(Outer) : null, React.createElement(ConfirmDialogHost)));
  });

  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const choice = (which: 'confirm' | 'cancel') => document.querySelector(`[data-confirm-choice="${which}"]`);
  /** Asks and hands back the pending answer (boxed: awaiting `ask` must not await the answer). */
  const ask = async (request: Parameters<typeof context.confirmAction>[0]): Promise<{ answer: Promise<boolean> }> => {
    let answer: Promise<boolean> | null = null;
    await React.act(async () => { answer = context.confirmAction(request); });
    return { answer: answer! };
  };
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const dialogName = () => {
    const el = dialog();
    return el ? document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent ?? null : null;
  };
  const occupants = () => slots.slotEntries('confirm.dialog').map((e) => e.pluginId);
  const registerProduct = async () => {
    let dispose: () => void = () => {};
    await React.act(async () => { dispose = slots.register({ slot: 'confirm.dialog', fallback: true, pluginId: '@timon/settings' }, ProductConfirmDialog); });
    return dispose;
  };

  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    loader.setLoadClientModuleForTests(null);
    loader.resetClientPluginsForTests();
    slots.resetSlotsForTests();
    // Radix restores the focus on a timer after the dialog closes.
    await new Promise((r) => setTimeout(r, 50));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, context, slots, loader, until, click, choice, ask, dialog, dialogName, occupants, registerProduct, unmount, outerOpen };
}

type Mounted = Awaited<ReturnType<typeof mountConfirmHost>>;

function acmeConfirm(m: Mounted): ComponentType {
  const { React, context } = m;
  return function AcmeConfirm() {
    const question = context.useConfirmDialog();
    if (!question) return null;
    return React.createElement('div', { 'data-acme': question.title, 'data-acme-destructive': String(question.destructive) },
      React.createElement('button', { type: 'button', 'data-acme-yes': '', onClick: question.confirm }, question.confirmLabel),
      React.createElement('button', { type: 'button', 'data-acme-no': '', onClick: question.cancel }, question.cancelLabel));
  };
}

test('the slot is declared at boot, and an empty slot still paints the product dialog', async () => {
  const m = await mountConfirmHost();
  try {
    assert.equal(m.slots.slotKind('confirm.dialog'), 'single');
    const { answer } = await m.ask({ title: 'Delete the secret GH?', description: 'Agents using it lose access.', confirmLabel: 'Delete', destructive: true });
    await m.until(() => !!m.choice('confirm'), 'the product dialog, without any occupant');
    assert.equal(m.dialogName(), 'Delete the secret GH?', 'the host names the dialog with the question');
    assert.equal(m.choice('confirm')?.textContent, 'Delete');
    assert.equal(m.choice('cancel')?.textContent, 'Cancel', 'default label');
    assert.equal(document.activeElement, m.choice('cancel'), 'a destructive question focuses Cancel');
    await m.click(m.choice('confirm'));
    assert.equal(await answer, true);
    await m.until(() => !m.dialog(), 'closed');

    const dispose = await m.registerProduct();
    assert.equal(m.slots.slotEntries('confirm.dialog')[0]?.fallback, true);
    const { answer: again } = await m.ask('Move it?');
    await m.until(() => !!m.choice('confirm'), 'the product dialog through the slot');
    assert.equal(m.choice('confirm')?.textContent, 'Confirm', 'default label');
    assert.equal(document.activeElement, m.choice('confirm'), 'a plain question focuses Confirm');
    await m.click(m.choice('cancel'));
    assert.equal(await again, false);
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('questions wait in line, and Escape answers no', async () => {
  const m = await mountConfirmHost();
  try {
    const first = await m.ask({ title: 'First?' });
    const second = await m.ask({ title: 'Second?' });
    await m.until(() => m.dialogName() === 'First?', 'the first question');
    await m.React.act(async () => {
      m.dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(await first.answer, false, 'Escape answers no');
    await m.until(() => m.dialogName() === 'Second?', 'the second question, in turn');
    await m.click(m.choice('confirm'));
    assert.equal(await second.answer, true);
  } finally {
    await m.unmount();
  }
});

test('asked from inside a modal, Escape closes the question alone', async () => {
  const m = await mountConfirmHost([], { outer: true });
  try {
    assert.ok(document.querySelector('[data-outer]'), 'the modal is open');
    const { answer } = await m.ask({ title: 'Discard unsaved changes?', destructive: true });
    await m.until(() => !!m.choice('cancel'), 'the question over the modal');
    await m.React.act(async () => {
      (document.activeElement ?? m.dialog()!).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(await answer, false);
    await m.until(() => !m.dialog(), 'the question closed');
    assert.equal(m.outerOpen.current, true, 'the modal under it stays open');
    assert.ok(document.querySelector('[data-outer]'));
  } finally {
    await m.unmount();
  }
});

test('without a host nothing is confirmed, and the last host leaving answers the waiting questions no', async () => {
  const { confirmAction, registerConfirmHost } = await import('./confirm-dialog-context');
  assert.equal(await confirmAction('Delete?'), false);
  const leave = registerConfirmHost();
  const waiting = confirmAction('Delete?');
  leave();
  assert.equal(await waiting, false);
});

test('a plugin takes the slot and answers through the host, and its removal gives the product dialog back', async () => {
  const m = await mountConfirmHost([ACME]);
  try {
    const dispose = await m.registerProduct();
    m.loader.setLoadClientModuleForTests(async () => ({
      apply(ctx) { ctx.slots.register({ slot: 'confirm.dialog' }, acmeConfirm(m)); },
    }));
    await m.React.act(async () => { await m.loader.syncClientPlugins(); });
    assert.equal(m.occupants()[0], 'acme-confirm', 'the replacement wins over the fallback');

    const { answer } = await m.ask({ title: 'Stop the mission?', destructive: true });
    await m.until(() => !!document.querySelector('[data-acme="Stop the mission?"]'), 'the replacement, told the question');
    assert.equal(document.querySelector('[data-acme]')?.getAttribute('data-acme-destructive'), 'true');
    assert.equal(m.choice('confirm'), null, 'the product dialog is not painted under it');
    assert.equal(m.dialogName(), 'Stop the mission?', 'the host still names the dialog');
    await m.click(document.querySelector('[data-acme-yes]'));
    assert.equal(await answer, true);

    m.loader.setLoadClientModuleForTests(null);
    await m.React.act(async () => { m.loader.resetClientPluginsForTests(); });
    const { answer: again } = await m.ask('Stop?');
    await m.until(() => !!m.choice('cancel'), 'the product dialog back');
    await m.click(m.choice('cancel'));
    assert.equal(await again, false);
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('the settings module registers the product dialog as the fallback, and the root layout mounts the host', () => {
  const settings = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'settings.tsx'), 'utf8');
  assert.match(settings, /ctx\.register\(\{ slot: CONFIRM_DIALOG_SLOT, fallback: true \}, ProductConfirmDialog\)/);
  const layout = readFileSync(resolve(process.cwd(), 'src', 'app', 'layout.tsx'), 'utf8');
  assert.match(layout, /<ConfirmDialogHost \/>/);
});

/** `examples/plugin-confirm-dialog`, loaded as the platform loads it: `react` and `@timon/ui` are the platform's own. */
async function loadExample(): Promise<{ apply: (ctx: unknown) => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-confirm-dialog', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__confirmDialogTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__confirmDialogTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const React = await import('react');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __confirmDialogTestReact: React, __confirmDialogTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'confirm-dialog-example-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the examples/plugin-confirm-dialog template asks a second click before a destructive yes, with the SDK alone', async () => {
  const m = await mountConfirmHost();
  const example = await loadExample();
  try {
    const disposeProduct = await m.registerProduct();
    const disposers: Array<() => void> = [];
    await m.React.act(async () => example.apply({
      id: 'example-confirm-dialog',
      slots: { register: (options: { slot: string }, Component: ComponentType) => {
        const dispose = m.slots.register({ ...options, pluginId: 'example-confirm-dialog' }, Component);
        disposers.push(dispose);
        return dispose;
      } },
    }));
    assert.equal(m.occupants()[0], 'example-confirm-dialog');

    const { answer } = await m.ask({ title: 'Delete the task?', confirmLabel: 'Delete', destructive: true });
    await m.until(() => document.querySelector('[data-two-step-title]')?.textContent === 'Delete the task?', 'the template, told the question');
    assert.equal(m.choice('confirm'), null, 'the product dialog is not painted under it');
    assert.equal(document.activeElement, document.querySelector('[data-two-step-cancel]'), 'the safe button holds the focus');
    let settled = false;
    void answer.then(() => { settled = true; });
    await m.click(document.querySelector('[data-two-step-confirm]'));
    await m.until(() => document.querySelector('[data-two-step-confirm]')?.getAttribute('data-two-step-confirm') === 'armed', 'armed by the first click');
    assert.equal(settled, false, 'one click does not answer');
    await m.click(document.querySelector('[data-two-step-confirm]'));
    assert.equal(await answer, true);

    const { answer: plain } = await m.ask('Convert the routine?');
    await m.until(() => document.querySelector('[data-two-step-title]')?.textContent === 'Convert the routine?', 'the next question, unarmed');
    await m.click(document.querySelector('[data-two-step-confirm]'));
    assert.equal(await plain, true, 'a plain question answers on one click');

    await m.React.act(async () => { for (const d of disposers.splice(0)) d(); });
    const { answer: again } = await m.ask('Stop?');
    await m.until(() => !!m.choice('cancel'), 'the product dialog back');
    await m.click(m.choice('cancel'));
    assert.equal(await again, false);
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    example.cleanup();
    await m.unmount();
  }
});

test('the question is drawn above every layer of the app', async () => {
  const m = await mountConfirmHost();
  try {
    const { answer } = await m.ask('Stop?');
    await m.until(() => !!m.dialog(), 'open');
    assert.match(m.dialog()!.className, /\bz-\[100\]/, 'the dialog');
    const overlay = Array.from(document.querySelectorAll('[data-state="open"]')).find((el) => el !== m.dialog() && /\bfixed\b/.test(el.className) && /inset-0/.test(el.className));
    assert.ok(overlay && /\bz-\[100\]/.test(overlay.className), 'its overlay');
    await m.click(m.choice('cancel'));
    assert.equal(await answer, false);
  } finally {
    await m.unmount();
  }
});
