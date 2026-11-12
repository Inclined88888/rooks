/**
 * Tests for the `ask_user` entry guard (permissions.ts).
 *
 * INCIDENT 2026-08-21, mission e6893b9e: an `ask_user` whose form never
 * displayed was reported back to the agent as "denied by user". The agent
 * concluded that the user refused to answer and decided on its own. These tests
 * lock down both halves of the fix: an unrenderable payload is refused
 * BEFORE any card, with a reason that points to the agent; and no refusal
 * reason attributes an intention to the user by default.
 *
 * `permissions.ts` imports the db module: ROOKS_HOME is redirected to a
 * temporary folder BEFORE the import (paths.ts reads the env at load time),
 * so nothing touches `~/.rooks/rooks.db`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-perm-test-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { validateAskUserPayload, malformedAskUserMessage, askUserChannelClosedMessage, DENY_REASONS,
        parseDecisionOrigin, requestPermission, listPending, buildContinuation, formatAskAnswer } = await import('./permissions.js');
const { dbApi } = await import('./db.js');

/** Events/notifications are foreign-keyed on `missions`: a card created on
 *  a non-existent mission would make the insert fail. */
function mission(id: string): string {
  dbApi.createMission(id, 'test.agent', 'test ask_user');
  return id;
}

/** Minimal payload compliant with the schema announced to the agent. */
function validPayload(): unknown {
  return {
    questions: [
      {
        question: 'Which option do we go with?',
        header: 'execution',
        options: [{ label: 'Sequential' }, { label: 'Kanban' }],
      },
    ],
  };
}

/* ── Pure validation ────────────────────────────────────────────────────────── */

test('compliant payload: no defect', () => {
  assert.equal(validateAskUserPayload(validPayload()), null);
});

test('compliant payload: 4 questions × 4 options, the high bounds pass', () => {
  const q = (i: number) => ({
    question: `question ${i} ?`,
    header: `h${i}`,
    options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }],
  });
  assert.equal(validateAskUserPayload({ questions: [q(1), q(2), q(3), q(4)] }), null);
});

test('questions missing / empty / not an array: named defect', () => {
  assert.match(validateAskUserPayload({}) ?? '', /`questions` missing/);
  assert.match(validateAskUserPayload({ questions: [] }) ?? '', /empty/);
  assert.match(validateAskUserPayload({ questions: 'oui' }) ?? '', /is not an array/);
  assert.match(validateAskUserPayload(null) ?? '', /not an object/);
});

test('more than 4 questions: refused, the count is cited', () => {
  const questions = Array.from({ length: 5 }, (_, i) => ({
    question: `q${i} ?`,
    options: [{ label: 'a' }, { label: 'b' }],
  }));
  const defect = validateAskUserPayload({ questions });
  assert.match(defect ?? '', /5 questions/);
  assert.match(defect ?? '', /maximum 4/);
});

test('question with no options: a free-text question, accepted', () => {
  assert.equal(validateAskUserPayload({
    questions: [
      { question: 'First?', options: [{ label: 'a' }, { label: 'b' }] },
      { question: 'What should the mail agent be called?', placeholder: 'assistant.mails' },
      { question: 'Anything else?', options: [] },
    ],
  }), null);
});

test('free-text question: multiSelect or a non-string placeholder LOCATES the faulty question', () => {
  const multi = validateAskUserPayload({
    questions: [
      { question: 'First?', options: [{ label: 'a' }, { label: 'b' }] },
      { question: 'Second?', multiSelect: true },
    ],
  });
  assert.match(multi ?? '', /question 2/);
  assert.match(multi ?? '', /"Second\?"/);
  assert.match(multi ?? '', /multiSelect/);
  assert.match(
    validateAskUserPayload({ questions: [{ question: 'Q?', placeholder: 3 }] }) ?? '',
    /placeholder/,
  );
});

test('`actor` is optional, and a value outside the list still renders (no badge) rather than costing the question', () => {
  const withActor = (actor: unknown) => ({
    questions: [{ question: 'Who switches?', header: 'Git', options: [{ label: 'Switch to main', actor }, { label: 'Leave it' }] }],
  });
  for (const actor of ['agent', 'user', undefined, 'Agent', 42]) assert.equal(validateAskUserPayload(withActor(actor)), null, String(actor));
});

test('a relaunched turn reads the free text beside the pick, never [object Object]', () => {
  const resumed = buildContinuation(
    { tool_name: 'ask_user', mission_id: 'm' } as never,
    { behavior: 'allow', updatedInput: { answers: {
      'Which branch?': 'main',
      'Which checks?': ['lint', 'types'],
      'Ship it?': { choice: 'Wait', text: 'after the demo' },
      'Which db?': { text: 'none of these' },
      'Which tests?': { choices: ['unit'], text: 'e2e later' },
    } } },
  );
  assert.match(resumed, /"Which branch\?": main/);
  assert.match(resumed, /"Which checks\?": lint, types/);
  assert.match(resumed, /"Ship it\?": Wait — with this remark: after the demo/);
  assert.match(resumed, /"Which db\?": none of these/);
  assert.match(resumed, /"Which tests\?": unit — with this remark: e2e later/);
  assert.doesNotMatch(resumed, /object Object|User's note/);
  assert.equal(formatAskAnswer({}), '(no answer)');
});

test('a card answered before the form changed, with its global note, still resumes with that note', () => {
  const resumed = buildContinuation(
    { tool_name: 'ask_user', mission_id: 'm' } as never,
    { behavior: 'allow', updatedInput: { answers: { 'Which?': 'a' }, note: ' ship it ' } },
  );
  assert.match(resumed, /"Which\?": a\nUser's note: ship it/);
});

test('fewer than 2 options, or an option with no label: refused', () => {
  assert.match(
    validateAskUserPayload({ questions: [{ question: 'Q?', options: [{ label: 'only' }] }] }) ?? '',
    /minimum 2/,
  );
  assert.match(
    validateAskUserPayload({ questions: [{ question: 'Q?', options: [{ label: 'a' }, {}] }] }) ?? '',
    /option 2.*`label` missing or empty/,
  );
  assert.match(
    validateAskUserPayload({
      questions: [{ question: 'Q?', options: [{ label: 'a' }, { label: '   ' }] }],
    }) ?? '',
    /option 2.*`label` missing or empty/,
  );
});

test('the refusal message points to the agent, never the user', () => {
  const msg = malformedAskUserMessage('field `questions` missing');
  assert.match(msg, /MALFORMED/);
  assert.match(msg, /field `questions` missing/);
  assert.match(msg, /saw nothing/);
  assert.match(msg, /re-issue/i);
  assert.doesNotMatch(msg, /denied by user/i);
});

test('what goes back to the agent names the tools it can call, not the card', () => {
  // The agent's tool list says `question` and `kanban_plan`: a message telling
  // it to re-issue `ask_user` points at a name it no longer sees.
  const toAgent = [
    malformedAskUserMessage('field `questions` missing'),
    askUserChannelClosedMessage('field `questions` missing', 3),
    DENY_REASONS.formUnrenderable,
  ];
  for (const msg of toAgent) {
    assert.match(msg, /`question`/);
    assert.match(msg, /`kanban_plan`/);
    assert.doesNotMatch(msg, /ask_user|ask_series_plan/);
  }
});

/* ── End to end: requestPermission ─────────────────────────────────────────── */

test('invalid ask_user: immediate deny, NO card created', async () => {
  const missionId = mission('test-mission-invalide');
  const decision = await requestPermission({
    mission_id: missionId,
    agent: 'test.agent',
    tool_name: 'ask_user',
    input: { questions: [] },
    tool_use_id: 'tuid-invalide',
  });
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.behavior === 'deny' ? decision.message : '', /MALFORMED/);
  assert.equal(listPending(missionId).length, 0, 'no card should be pending');
});

test('valid ask_user: the card is created and the request stays pending', async () => {
  const missionId = mission('test-mission-valide');
  // requestPermission only resolves on an action: we don't await it, we
  // observe the card created synchronously.
  void requestPermission({
    mission_id: missionId,
    agent: 'test.agent',
    tool_name: 'ask_user',
    input: validPayload(),
    tool_use_id: 'tuid-valide',
  });
  const pending = listPending(missionId);
  assert.equal(pending.length, 1, 'a card should be pending');
  assert.equal(pending[0]?.tool_name, 'ask_user');
});

/* ── TYPED forms (series planner) ─────────────────────────────────────────
 * They replace `questions`: the agent only sends the project's context, the
 * UI builds the menus from the catalog. The guard must therefore let them
 * pass WITHOUT `questions`, while still refusing whatever no UI would know
 * how to render — an unknown `kind`, an empty form.
 * ───────────────────────────────────────────────────────────────────────── */

test('valid typed form: accepted without `questions`', () => {
  const form = { kind: 'series_plan', chantier: 'Refonte', volets: [{ title: 'front' }] };
  assert.equal(validateAskUserPayload({ form }), null);
});

test('typed form: volet groups accepted, too many distinct groups refused', () => {
  const volets = [{ title: 'a', group: 'simple' }, { title: 'b', group: 'complex' }, { title: 'c' }];
  assert.equal(validateAskUserPayload({ form: { kind: 'series_plan', chantier: 'Refonte', volets } }), null);
  const many = Array.from({ length: 7 }, (_, i) => ({ title: `v${i}`, group: `g${i}` }));
  assert.match(String(validateAskUserPayload({ form: { kind: 'series_plan', chantier: 'x', volets: many } })), /maximum 6/);
});

test('typed form with an unknown kind: refused, the kind is cited', () => {
  const defect = validateAskUserPayload({ form: { kind: 'wizard_magique' } });
  assert.match(String(defect), /wizard_magique/);
});

test('malformed typed form: the defect comes from the kind\'s validator', () => {
  const defect = validateAskUserPayload({ form: { kind: 'series_plan', chantier: 'x', volets: [] } });
  assert.match(String(defect), /empty/);
});

test('a non-object `form` is refused rather than treated as questions', () => {
  assert.match(String(validateAskUserPayload({ form: 'series_plan' })), /form/);
});

test('another tool is never validated by the ask_user guard', () => {
  const missionId = mission('test-mission-autre-outil');
  void requestPermission({
    mission_id: missionId,
    agent: 'test.agent',
    tool_name: 'Bash',
    input: { command: 'ls' }, // no `questions`: outside the guard's scope
    tool_use_id: 'tuid-bash',
  });
  assert.equal(listPending(missionId).length, 1);
});

/* The form tool is called `question` by the model since the rename, but the
 * CARD kept its persisted name: the shim posts `ask_user` whatever was called.
 * The public name is deliberately not mapped onto the card here — a backend's
 * own tool can be named `question` (opencode has one), and a permission
 * request for it is an Allow/Deny card, not a form to validate. */
test('a tool a backend itself calls `question` stays an Allow/Deny card', async () => {
  const missionId = mission('test-mission-question-native');
  void requestPermission({
    mission_id: missionId,
    agent: 'test.agent',
    tool_name: 'question',
    input: { questions: [] }, // would be refused as a malformed form
    tool_use_id: 'tuid-question-native',
  });
  const pending = listPending(missionId);
  assert.equal(pending.length, 1, 'a card, not an entry refusal');
  assert.equal(pending[0]?.tool_name, 'question');
});

/* ── Reasons and origins ────────────────────────────────────────────────────── */

test('no refusal reason contains "denied by user"', () => {
  for (const [name, msg] of Object.entries(DENY_REASONS)) {
    assert.doesNotMatch(msg, /denied by user/i, `${name} must not attribute a default refusal`);
  }
});

test('the default reason assumes no intention', () => {
  assert.match(DENY_REASONS.noMessage, /no reason passed/);
  assert.match(DENY_REASONS.noMessage, /do not assume/);
});

test('cancellation and refusal are two distinct, explicit reasons', () => {
  assert.notEqual(DENY_REASONS.formCancelled, DENY_REASONS.userDenied);
  assert.match(DENY_REASONS.formCancelled, /Cancel/);
  assert.match(DENY_REASONS.formCancelled, /NOT a refusal/);
  assert.match(DENY_REASONS.userDenied, /Deny/);
  assert.match(DENY_REASONS.formUnrenderable, /NEVER saw/);
});

test('parseDecisionOrigin: known values kept, unknown falls back to unknown', () => {
  assert.equal(parseDecisionOrigin('ui_form_cancel'), 'ui_form_cancel');
  assert.equal(parseDecisionOrigin('push_action'), 'push_action');
  assert.equal(parseDecisionOrigin('n_importe_quoi'), 'unknown');
  assert.equal(parseDecisionOrigin(undefined), 'unknown');
  assert.equal(parseDecisionOrigin(42), 'unknown');
});

/* ── Malformed-form loop: bound + escalation ───────────────────────────────── */

/**
 * A `payload_invalid` rejection creates NO card: the loop
 * "deny → same faulty payload → deny" is therefore invisible to the user and can
 * run all night on an autonomous mission. These tests lock down the bound:
 * escalation on the 3rd failure, only once, and a reset as soon as a valid
 * form goes through.
 */

/** Sends an invalid payload and returns the refusal message given to the agent. */
async function rejectOnce(missionId: string, n: number): Promise<string> {
  const decision = await requestPermission({
    mission_id: missionId,
    agent: 'test.agent',
    tool_name: 'ask_user',
    input: { questions: [] },
    tool_use_id: `tuid-boucle-${n}`,
  });
  return decision.behavior === 'deny' ? decision.message : '';
}

/** System alerts actually posted to the user for this mission (notifyUser). */
function alertsFor(missionId: string): number {
  return dbApi
    .listMessagesForMission(missionId)
    .filter((m) => m.kind === 'notification' && m.payload.includes('Agent form looping'))
    .length;
}

test('3 invalid payloads in a row: the ask_user channel is closed', async () => {
  const missionId = mission('test-mission-boucle');
  assert.match(await rejectOnce(missionId, 1), /Fix the payload/);
  assert.match(await rejectOnce(missionId, 2), /Fix the payload/);
  const third = await rejectOnce(missionId, 3);
  assert.match(third, /CLOSED/);
  assert.match(third, /do not retry it/);
  assert.match(third, /rooks task block/);
  assert.match(third, /assumption/i);
  // The bound must not turn the refusal into something else: always a deny,
  // always without a card.
  assert.equal(listPending(missionId).length, 0);
  // Past the threshold the channel stays closed (and the alert itself does not
  // repeat — the escalation counter is `attempts === threshold`, not `>=`).
  assert.match(await rejectOnce(missionId, 4), /CLOSED/);
  assert.equal(alertsFor(missionId), 1, 'Robin is alerted only once, not on every rejection');
});

test('a valid form in between resets the counter to zero', async () => {
  const missionId = mission('test-mission-reset');
  await rejectOnce(missionId, 1);
  await rejectOnce(missionId, 2);
  // Correct form: the card is created (permission_request event), which
  // interrupts the series. We don't await the resolution — no one will click.
  void requestPermission({
    mission_id: missionId,
    agent: 'test.agent',
    tool_name: 'ask_user',
    input: validPayload(),
    tool_use_id: 'tuid-reset-valide',
  });
  assert.equal(listPending(missionId).length, 1);
  // The agent corrected itself: the two previous failures must no longer count.
  assert.match(await rejectOnce(missionId, 3), /Fix the payload/);
  assert.match(await rejectOnce(missionId, 4), /Fix the payload/);
  assert.match(await rejectOnce(missionId, 5), /CLOSED/);
  assert.equal(alertsFor(missionId), 1, 'a single alert, at the threshold crossing');
});

test('a valid form is never affected by the bound', async () => {
  const missionId = mission('test-mission-valide-apres-boucle');
  for (let i = 1; i <= 4; i++) await rejectOnce(missionId, i);
  // Even with the channel "closed", a renderable payload creates its card: the
  // bound cuts the loop of faulty payloads, not the ability to ask correctly.
  void requestPermission({
    mission_id: missionId,
    agent: 'test.agent',
    tool_name: 'ask_user',
    input: validPayload(),
    tool_use_id: 'tuid-valide-apres',
  });
  assert.equal(listPending(missionId).length, 1);
});

test('the escalation message does not send the agent back to fix its payload', () => {
  const msg = askUserChannelClosedMessage('empty `questions` array', 3);
  assert.match(msg, /invalid payload #3/);
  assert.doesNotMatch(msg, /re-issue/i);
  assert.match(msg, /The user has been alerted/);
  assert.doesNotMatch(msg, /denied by user/i);
});
