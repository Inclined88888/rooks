/**
 * A chat in a widget card takes its margins from the card (globals.css):
 * bordered, the same margin on the sides and under the composer; borderless,
 * none, except on a phone or inside a container. jsdom computes no
 * stylesheet, so this guards the rules and the two markers they hang on.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const src = (path: string) => readFileSync(join(process.cwd(), 'src', path), 'utf8');

test('the widget card drives the chat\'s margins, bordered or not', () => {
  const css = src('styles/globals.css').replace(/\s+/g, ' ');
  assert.ok(css.includes('.widget-frame [data-chat-shell] { --chat-pad: 8px; }'), 'bordered: a margin');
  assert.ok(css.includes('.widget-frame [data-chat-shell] [data-composer-dock] { padding-bottom: var(--chat-pad); }'), 'the same margin under the composer as on its sides');
  assert.ok(css.includes('.widget-frame[data-borderless] [data-chat-shell] { --chat-pad: 0px; }'), 'borderless: none, aligned with the other widgets');
  assert.match(css, /\.widget-stack\[data-borderless\] \[data-chat-shell\], \.rooks-island \.widget-frame\[data-borderless\] \[data-chat-shell\] \{ --chat-pad: 6px; \}/, 'in a container: a mini margin');
  assert.match(css, /@media \(max-width: 767px\) \{ \.widget-frame\[data-borderless\] \[data-chat-shell\] \{ --chat-pad: 6px; \} \}/, 'on a phone: a mini margin');
  assert.ok(src('app/chat/chat-client.tsx').includes('data-chat-shell=""'), 'the chat root carries --chat-pad');
  assert.ok(src('components/chat/composer.tsx').includes('data-composer-dock=""'), 'the composer\'s dock is marked');
});

test('a Multichat cell keeps a mini margin around its dense composer', () => {
  assert.ok(src('components/chat/composer.tsx').includes('dense ? "px-1.5 pb-1.5"'), 'off the cell\'s outline, sides and bottom alike');
});
