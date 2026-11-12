import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';
// Not the component: importing it here would load React DOM before jsdom is
// installed, and React would then ignore every `input` event.
import { joinLocalValue, splitLocalValue } from '@/lib/date-time-value';

test('the value keeps the datetime-local shape both ways', () => {
  const parts = splitLocalValue('2026-11-02T14:30');
  assert.ok(parts);
  assert.equal(parts.date.getFullYear(), 2026);
  assert.equal(parts.date.getMonth(), 10);
  assert.equal(parts.date.getDate(), 2);
  assert.equal(parts.time, '14:30');
  assert.equal(joinLocalValue(parts.date, parts.time), '2026-11-02T14:30');
  assert.equal(joinLocalValue(new Date(2026, 0, 5), 'nope'), '2026-01-05T09:00', 'a bad time falls back to 09:00');
  assert.equal(splitLocalValue(''), null);
  assert.equal(splitLocalValue('soon'), null);
});

test('a day picked in the calendar, then an hour, then cleared', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node',
    'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { DateTimePicker } = await import('./date-time-picker');

  const values: string[] = [];
  // The picker is controlled: a holder keeps its value the way a form does.
  function Holder() {
    const [value, setValue] = React.useState('');
    return React.createElement(DateTimePicker, {
      value,
      onChange: (v: string) => { values.push(v); setValue(v); },
      placeholder: 'As soon as possible',
      disablePast: false,
    });
  }
  const root = createRoot(document.getElementById('root')!);
  const render = async () => {
    await React.act(async () => { root.render(React.createElement(Holder)); });
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };

  try {
    await render();
    const trigger = $('[data-date-time-picker]');
    assert.match(trigger?.textContent ?? '', /As soon as possible/);
    assert.ok(!$('input[type="datetime-local"]'), 'no native date popup');

    await click(trigger);
    await until(() => document.querySelectorAll('[role="dialog"] td button').length > 27, 'the month grid');
    const fifteenth = Array.from(document.querySelectorAll('[role="dialog"] td button'))
      .find((b) => b.textContent === '15' && !b.closest('td')?.className.includes('outside'));
    await click(fifteenth);
    await until(() => values.length === 1, 'the pick');
    assert.match(values[0]!, /^\d{4}-\d{2}-15T09:00$/, 'a picked day starts at 09:00');

    await until(() => $<HTMLInputElement>('[role="dialog"] input[type="time"]')?.disabled === false, 'the hour field to open with a day');
    const time = $<HTMLInputElement>('[role="dialog"] input[type="time"]');
    assert.ok(time);
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(time, '18:45');
      time.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      time.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await until(() => values.length === 2, 'the hour');
    assert.match(values[1]!, /-15T18:45$/);

    await click(Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === 'Done'));
    await until(() => !$('[role="dialog"]'), 'the calendar to close');
    await click($('button[aria-label="Clear the date"]'));
    await until(() => values.length === 3, 'the clear');
    assert.equal(values[2], '');
  } finally {
    await React.act(async () => { root.unmount(); });
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  }
});
