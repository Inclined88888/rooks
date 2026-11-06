/**
 * The dates inside the daemon's own sentences are English whatever the host's
 * locale (TODO #545): a hard-coded `'fr-FR'` used to put "jeu. 30 oct." in the
 * notifications and logs of every tester.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageDateTime, messageDay, messageTime } from './message-dates.js';

const AT = new Date(2026, 9, 30, 14, 5);

test('messageTime is a 24-hour hh:mm', () => {
  assert.equal(messageTime(AT), '14:05');
  assert.equal(messageTime(AT.getTime()), '14:05');
});

test('messageDateTime spells the month out, in English', () => {
  assert.equal(messageDateTime(AT), '30 Oct 2026, 14:05');
});

test('messageDay is an English day heading, and a civil key stays on its day in UTC', () => {
  assert.equal(messageDay(AT), 'Fri 30 Oct');
  assert.equal(messageDay(new Date('2026-08-20T12:00:00.000Z'), 'UTC'), 'Thu 20 Aug');
});
