import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { applyBrowserFrameDisplay, DESKTOP_RES, fitDesktopViewport } from './browser-display';

test('portrait phone shows the entire desktop width with equal black bands', () => {
  const fit = fitDesktopViewport(390, 756);
  assert.equal(DESKTOP_RES.width * fit.scale, 390);
  assert.equal(fit.left, 0);
  assert.ok(fit.top > 250);
  assert.equal(fit.top * 2 + DESKTOP_RES.height * fit.scale, 756);
});

test('short landscape view keeps the aspect ratio and the whole desktop in bounds', () => {
  const fit = fitDesktopViewport(844, 300);
  assert.equal(DESKTOP_RES.height * fit.scale, 300);
  assert.equal(fit.top, 0);
  assert.ok(fit.left > 0);
  assert.equal(fit.left * 2 + DESKTOP_RES.width * fit.scale, 844);
});

test('switching modes and reconnecting reuse the frame, without resizing another session', () => {
  const dom = new JSDOM('<div><iframe></iframe><iframe></iframe></div>', { url: 'http://localhost/chat' });
  try {
    const [frame, other] = Array.from(dom.window.document.querySelectorAll('iframe'));
    assert.ok(frame && other && frame.parentElement);
    frame.parentElement.getBoundingClientRect = () => ({ width: 390, height: 756 }) as DOMRect;
    const messages: unknown[] = [];
    frame.contentWindow!.postMessage = (message: unknown) => { messages.push(message); };
    other.contentWindow!.postMessage = () => { assert.fail('changed another session'); };
    const originalWindow = frame.contentWindow;
    applyBrowserFrameDisplay(frame, 'desktop');
    assert.equal(frame.style.width, '1366px');
    assert.equal(frame.style.height, '768px');
    assert.notEqual(frame.style.transform, 'none');
    assert.deepEqual(messages, [
      { type: 'setScaleLocally', value: true },
      { type: 'setManualResolution', width: 1366, height: 768 },
    ]);
    applyBrowserFrameDisplay(frame, 'desktop');
    assert.equal(messages.length, 2, 'panel resizing should not resend the fixed desktop resolution');
    applyBrowserFrameDisplay(frame, 'desktop', true);
    assert.equal(messages.length, 4, 'a reloaded document needs its stored mode reapplied');
    applyBrowserFrameDisplay(frame, 'auto');
    assert.equal(frame.style.width, '100%');
    assert.equal(frame.style.height, '100%');
    assert.equal(frame.style.transform, 'none');
    assert.deepEqual(messages.at(-1), { type: 'resetResolutionToWindow' });
    assert.equal(frame.contentWindow, originalWindow, 'mode changes must preserve the session document');
    assert.equal(other.getAttribute('style'), null);
  } finally { dom.window.close(); }
});
