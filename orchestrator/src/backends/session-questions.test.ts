import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askRequestProblem, readSessionAnswers } from './session-questions.js';
import { validateAskUserPayload } from '../permissions.js';
import { askUserInput } from './session-questions.js';

test('a card the session layer accepts is one the question form renders', () => {
  const req = {
    id: null,
    questions: [
      { question: 'Line one\nline two?', header: 'Plan', options: [{ label: 'Approve' }, { label: 'Reject', description: 'say why' }] },
      { question: 'Free?', placeholder: 'type' },
      { question: 'Several?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    ],
  };
  assert.equal(askRequestProblem(req), null);
  assert.equal(validateAskUserPayload(askUserInput(req)), null);
});

test('what cannot be shown is named', () => {
  const one = (q: object) => askRequestProblem({ id: null, questions: [q as never] });
  assert.equal(askRequestProblem({ id: null, questions: [] }), 'no question');
  assert.match(askRequestProblem({ id: null, questions: Array.from({ length: 5 }, (_, i) => ({ question: `q${i}` })) })!, /5 questions/);
  assert.match(one({ question: ' ' })!, /no text/);
  assert.match(one({ question: 'x', options: [{ label: 'only' }] })!, /1 options/);
  assert.match(one({ question: 'x', options: Array.from({ length: 5 }, (_, i) => ({ label: `o${i}` })) })!, /5 options/);
  assert.match(one({ question: 'x', multiSelect: true })!, /multiple choice/);
  assert.match(one({ question: 'x'.repeat(8_001) })!, /over 8000/);
  assert.match(askRequestProblem({ id: null, questions: [{ question: 'same' }, { question: 'same' }] })!, /question 2: the same text/);
});

test('answers: labels in the order offered, anything else is text, a missing answer is empty', () => {
  const questions = [
    { question: 'Pick', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    { question: 'One', options: [{ label: 'yes' }, { label: 'no' }] },
    { question: 'Silent', options: [{ label: 'yes' }, { label: 'no' }] },
  ];
  assert.deepEqual(readSessionAnswers(questions, { answers: { Pick: ['c', 'a', 'zz'], One: { text: 'it depends' } } }), {
    Pick: { picked: ['a', 'c'], text: 'zz' },
    One: { picked: [], text: 'it depends' },
    Silent: { picked: [], text: null },
  });
  assert.deepEqual(readSessionAnswers(questions.slice(1, 2), null), { One: { picked: [], text: null } });
});

test('the plan card carries the webview locale key of each word the daemon wrote; an agent\'s own words carry none', async () => {
  const { acpExtensionCards } = await import('./acp/extensions.js');
  let input: ReturnType<typeof askUserInput> | undefined;
  const cards = acpExtensionCards(async (req) => {
    input = askUserInput(req);
    return { answered: false, reason: 'closed' };
  }, new AbortController().signal);
  await cards.approvePlan({ title: 'Approve the plan', plan: 'Reject the plan' });
  assert.ok(input);
  assert.equal(validateAskUserPayload(input), null);
  const [q] = input.questions as Array<{ question: string; headerKey?: string; questionKey?: string; options: Array<Record<string, string>> }>;
  assert.equal(q!.headerKey, 'askCard.planHeader');
  // The plan is the agent's: its text is never keyed, even when it reads like a label.
  assert.equal(q!.question, 'Approve the plan\n\nReject the plan');
  assert.equal(q!.questionKey, undefined);
  assert.deepEqual(q!.options, [
    { label: 'Approve the plan', labelKey: 'askCard.planApprove', description: 'The agent carries it out.', descriptionKey: 'askCard.planApproveDescription' },
    { label: 'Reject the plan', labelKey: 'askCard.planReject', description: 'The agent does not; say why in the field below.', descriptionKey: 'askCard.planRejectDescription' },
  ]);
  const own = askUserInput({ id: null, questions: [{ question: 'Go?', header: 'Deploy', options: [{ label: 'Yes', description: 'now' }, { label: 'No' }] }] });
  assert.deepEqual(own.questions[0], { question: 'Go?', header: 'Deploy', options: [{ label: 'Yes', description: 'now' }, { label: 'No' }] });
});
